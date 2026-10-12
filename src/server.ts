import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import type { ServerWebSocket } from "bun";
import index from "../public/index.html";
import { compile, ENGINES, REPO, type CompileResult } from "./compile";
import { ClaudeSession } from "./claude";
import { writeBrief } from "./brief";
import { HistoryStore, editLabel, type Snapshot } from "./history";
import { CONTENT_TYPES, documentsIn, ensureClaudeHooks, keepWatching, resolveTreePath, scanTree, seedWorkspace, type DirNode } from "./workspace";

// Usage: bun dev [latex-dir] [--resumes dir] [--port 4747] [--no-open]
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(port|resumes)$/));

const LATEX = path.resolve(positional[0] ?? path.join(REPO, "latex"));
const RESUMES = path.resolve(option("--resumes") ?? path.join(REPO, "resumes"));
const BUILD = path.join(REPO, "build", path.basename(LATEX));
const PORT = Number(option("--port") ?? process.env.PORT ?? 4747);
// Sidebar paths start with one of these keys, e.g. "latex/main.tex".
const ROOTS = { latex: LATEX, resumes: RESUMES };

if (!ENGINES.some((e) => Bun.which(e))) {
  console.error("No LaTeX engine found (pdflatex / xelatex / lualatex). Run `bun run doctor` for install steps.");
  process.exit(1);
}

// ---------- workspace ----------

let latexTree: DirNode;
let resumesTree: DirNode;
let docs: string[] = [];

async function rescan() {
  latexTree = await scanTree(LATEX, "latex");
  resumesTree = await scanTree(RESUMES, "resumes");
  docs = documentsIn(latexTree).map((d) => `latex/${d}`);
}

const treeMessage = () =>
  JSON.stringify({ type: "tree", trees: [latexTree, resumesTree], docs, roots: ROOTS, history: history !== null });

// ---------- compiling ----------

type DocState = {
  last?: CompileResult;
  version: number; // bumps on every successful build, used to bust the PDF cache
  compiling: boolean;
  queued: boolean;
};

const states = new Map<string, DocState>();
const stateOf = (doc: string) => {
  let s = states.get(doc);
  if (!s) states.set(doc, (s = { version: 0, compiling: false, queued: false }));
  return s;
};
const relDoc = (doc: string) => doc.slice("latex/".length);
const outDirOf = (doc: string) => path.join(BUILD, relDoc(doc).replace(/\.tex$/, ""));
// The last successful PDF is kept separately so a broken build never blanks the preview.
const goodPdfOf = (doc: string) => path.join(outDirOf(doc), "underleaf-latest.pdf");

async function build(doc: string) {
  const s = stateOf(doc);
  if (s.compiling) {
    s.queued = true;
    return;
  }
  s.compiling = true;
  try {
    do {
      s.queued = false;
      send(doc, { type: "compiling", doc });
      const result = await compile(path.join(LATEX, relDoc(doc)), outDirOf(doc));
      if (result.ok) {
        await copyFile(result.pdfPath, goodPdfOf(doc));
        s.version++;
      }
      s.last = result;
      send(doc, compiledMessage(doc));
      scheduleBrief();
      const errors = result.diagnostics.filter((d) => d.severity === "error").length;
      console.log(`${result.ok ? "✓" : "✗"} ${relDoc(doc)}  ${result.ms}ms${result.ok ? `  ${result.pages}p` : `  ${errors} error(s)`}`);
    } while (s.queued);
  } finally {
    s.compiling = false;
  }
}

function compiledMessage(doc: string) {
  const s = stateOf(doc);
  const r = s.last!;
  return {
    type: "compiled",
    doc,
    ok: r.ok,
    engine: r.engine,
    ms: r.ms,
    pages: r.pages,
    diagnostics: r.diagnostics,
    pdf: s.version > 0 ? `/api/pdf?doc=${encodeURIComponent(doc)}&v=${s.version}` : null,
  };
}

/** Exported PDFs mirror the source layout: latex/acme/main.tex → resumes/acme/main.pdf */
async function exportDoc(doc: string) {
  const dest = path.join(RESUMES, relDoc(doc).replace(/\.tex$/, ".pdf"));
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(goodPdfOf(doc), dest);
  return `resumes/${path.relative(RESUMES, dest)}`;
}

// ---------- sockets ----------

type WsData = { channel: "app" | "claude"; doc?: string };
const appClients = new Set<ServerWebSocket<WsData>>();
// Claude Code hooks call back into this server; the token only exists in the env we give Claude.
const HOOK_TOKEN = crypto.randomUUID();
const claude = new ClaudeSession(LATEX, { UNDERLEAF_HOOK_TOKEN: HOOK_TOKEN }, () => (turn = null));

function broadcast(msg: object) {
  const payload = JSON.stringify(msg);
  for (const ws of appClients) ws.send(payload);
}

let lastOpened: string | null = null; // most recent document opened in any tab, for Claude's snapshot

function send(doc: string, msg: object) {
  const payload = JSON.stringify(msg);
  for (const ws of appClients) if (ws.data.doc === doc) ws.send(payload);
}

// ---------- workspace snapshot for Claude ----------

let briefTimer: Timer | undefined;
function scheduleBrief() {
  clearTimeout(briefTimer);
  briefTimer = setTimeout(() => {
    const results = new Map(docs.map((d) => [d, states.get(d)?.last]));
    const compiling = new Set(docs.filter((d) => states.get(d)?.compiling));
    writeBrief(LATEX, { latex: latexTree, resumes: resumesTree, results, compiling, open: lastOpened });
  }, 150);
}

// ---------- version history ----------
// Snapshots land in ~/.underleaf/history/<workspace id>.git. Three triggers:
//   • a Claude turn ends (Stop hook)          → "Claude: <prompt>"
//   • you stop editing for EDIT_IDLE_MS         → "You edited main.tex"
//   • Save PDF                                  → "Exported resumes/…"

const EDIT_IDLE_MS = 10_000;
const TURN_STALE_MS = 30 * 60_000; // a turn with no Stop (crash, killed process) stops counting after this

let history: HistoryStore | null = null;
let turn: { prompt: string; since: number } | null = null;
let editTimer: Timer | undefined;

function claudeIsWorking() {
  if (turn && Date.now() - turn.since > TURN_STALE_MS) turn = null;
  return turn !== null;
}

async function snapshot(req: Parameters<HistoryStore["snapshot"]>[0]): Promise<Snapshot | null> {
  if (!history) return null;
  try {
    const snap = await history.snapshot(req);
    if (snap) {
      broadcast({ type: "history" });
      console.log(`◷ ${snap.label}`);
    }
    return snap;
  } catch (e) {
    console.error(`history: ${(e as Error).message}`);
    return null;
  }
}

/** Your edits are grouped: one snapshot once you've paused. Claude's are grouped per turn instead. */
function scheduleEditSnapshot() {
  clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    editTimer = undefined;
    if (!claudeIsWorking()) snapshot({ kind: "edit", author: "You", label: (c) => editLabel(c) });
  }, EDIT_IDLE_MS);
}

function claudeLabel(prompt: string | undefined, changed: string[]) {
  const line = prompt?.split("\n").find((l) => l.trim())?.trim();
  if (!line) return editLabel(changed, "Claude edited");
  return `Claude: ${line.length > 72 ? line.slice(0, 71) + "…" : line}`;
}

async function onClaudeHook(event: string, body: { prompt?: string }) {
  if (event === "prompt") {
    turn = { prompt: body.prompt ?? "", since: Date.now() };
  } else if (event === "stop") {
    const prompt = turn?.prompt;
    turn = null;
    clearTimeout(editTimer); // this snapshot covers any pending edits too
    await snapshot({ kind: "claude", author: "Claude", label: (c) => claudeLabel(prompt, c) });
  }
}

/** Compiled PDFs of past versions, one build per (snapshot, document). */
const HISTORY_BUILD = path.join(BUILD, ".history");
const historyBuilds = new Map<string, Promise<CompileResult | null>>();

function buildSnapshot(commit: string, rel: string): Promise<CompileResult | null> {
  const key = `${commit}:${rel}`;
  let pending = historyBuilds.get(key);
  if (!pending) {
    pending = (async () => {
      const root = path.join(HISTORY_BUILD, commit);
      const src = path.join(root, "src");
      if (!(await Bun.file(path.join(src, rel)).exists())) await history!.exportTree(commit, src);
      return compile(path.join(src, rel), path.join(root, "out", rel.replace(/\.tex$/, "")));
    })().catch((e) => {
      console.error(`history: ${(e as Error).message}`);
      return null;
    });
    historyBuilds.set(key, pending);
    pending.then((r) => !r?.ok && historyBuilds.delete(key)); // retry failures next time
  }
  return pending;
}

// Workspace-relative path inside latex/, with no way to climb out of it.
const safeRel = (p: string | null) =>
  p && !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes("..") ? p : null;
const safeCommit = (c: string | null) => (c && /^[0-9a-f]{7,40}$/.test(c) ? c : null);

// ---------- watching ----------

let pending: Timer | undefined;
const changed = new Set<string>();

/** `treePath` is "latex/…" or "resumes/…" (or just the root key when a root was recreated). */
function onFsChange(treePath: string) {
  // Hidden paths (.underleaf/, .claude/, .git/) never affect the tree or a build.
  if (/(^|\/)(\.[^/]+|node_modules)(\/|$)/.test(treePath)) return;
  changed.add(treePath);
  if (treePath.startsWith("latex/")) scheduleEditSnapshot();
  clearTimeout(pending);
  // Editors (and Claude) often write a file in several steps; wait for things to settle.
  pending = setTimeout(async () => {
    const paths = [...changed];
    changed.clear();
    await rescan();
    const payload = treeMessage();
    for (const ws of appClients) ws.send(payload);
    // Rebuild what's open (an \input'd fragment may have changed) plus any document
    // that changed itself, so Claude's snapshot reflects edits to files nobody has open.
    const targets = new Set([...appClients].map((ws) => ws.data.doc).filter((d): d is string => !!d));
    for (const p of paths) if (docs.includes(p)) targets.add(p);
    for (const doc of targets) if (docs.includes(doc)) build(doc);
    scheduleBrief();
  }, 120);
}

await seedWorkspace(LATEX, path.join(REPO, "templates"));
// Hooks first, so the settings change is part of the first snapshot rather than looking like an edit.
if (Bun.which("git")) await ensureClaudeHooks(LATEX, `http://127.0.0.1:${PORT}`);
history = await HistoryStore.open(LATEX).catch((e) => {
  console.error(`history disabled: ${(e as Error).message}`);
  return null;
});
if (!history) console.log("history   disabled (git not found)");
await keepWatching(LATEX, (f) => onFsChange(f ? `latex/${f}` : "latex"));
await keepWatching(RESUMES, (f) => onFsChange(f ? `resumes/${f}` : "resumes"));
await rescan();
scheduleBrief();

// Compile everything once in the background so Claude starts with real page counts.
(async () => {
  for (const doc of docs) await build(doc);
})();

// ---------- http ----------

// The server can drive a shell-capable agent, so only talk to pages served by
// this server: reject foreign Origins (cross-site requests) and Hosts (DNS rebinding).
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
function trusted(req: Request) {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  return !!host && ALLOWED_HOSTS.has(host) && (!origin || ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, "")));
}
const forbidden = () => new Response("Forbidden", { status: 403 });

const workerPath = Bun.resolveSync("pdfjs-dist/build/pdf.worker.min.mjs", REPO);

const server = Bun.serve<WsData>({
  hostname: "127.0.0.1",
  port: PORT,
  // Bun's dev mode (HMR + browser errors echoed to this terminal) is only useful when
  // hacking on underleaf's UI; otherwise it relays noise from browser extensions.
  development: process.env.UNDERLEAF_DEV === "1",
  routes: {
    "/": index,
    "/pdf.worker.mjs": () => new Response(Bun.file(workerPath), { headers: { "Content-Type": "text/javascript" } }),

    "/api/pdf": (req: Request) => {
      if (!trusted(req)) return forbidden();
      const url = new URL(req.url);
      const doc = url.searchParams.get("doc") ?? "";
      if (!docs.includes(doc) || stateOf(doc).version === 0) return new Response("Not compiled", { status: 404 });
      const filename = path.basename(doc, ".tex") + ".pdf";
      const disposition = url.searchParams.has("download") ? "attachment" : "inline";
      return new Response(Bun.file(goodPdfOf(doc)), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `${disposition}; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    },

    "/api/file": async (req: Request) => {
      if (!trusted(req)) return forbidden();
      const url = new URL(req.url);
      const abs = await resolveTreePath(ROOTS, url.searchParams.get("path") ?? "");
      if (!abs) return new Response("Not found", { status: 404 });
      const ext = path.extname(abs).toLowerCase();
      const headers: Record<string, string> = {
        "Content-Type": CONTENT_TYPES[ext] ?? "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        // SVGs can carry scripts; never let a served file run in our origin.
        "Content-Security-Policy": "sandbox",
      };
      if (url.searchParams.has("download")) headers["Content-Disposition"] = `attachment; filename="${path.basename(abs)}"`;
      return new Response(Bun.file(abs), { headers });
    },

    "/api/hooks/claude": {
      POST: async (req: Request) => {
        if (!trusted(req) || req.headers.get("x-underleaf-token") !== HOOK_TOKEN) return forbidden();
        const event = new URL(req.url).searchParams.get("event") ?? "";
        await onClaudeHook(event, await req.json().catch(() => ({})));
        return new Response(null, { status: 204 }); // empty body: nothing gets added to Claude's context
      },
    },

    "/api/history": (req: Request) => {
      if (!trusted(req)) return forbidden();
      const treePath = new URL(req.url).searchParams.get("path") ?? "";
      const rel = safeRel(treePath.startsWith("latex/") ? treePath.slice("latex/".length) : null);
      if (!history || !rel) return Response.json({ enabled: history !== null, snapshots: [] });
      return history.log(rel).then((snapshots) => Response.json({ enabled: true, snapshots }));
    },

    "/api/history/file": async (req: Request) => {
      if (!trusted(req)) return forbidden();
      const url = new URL(req.url);
      const commit = safeCommit(url.searchParams.get("commit"));
      const rel = safeRel(url.searchParams.get("path"));
      if (!history || !commit || !rel) return new Response("Not found", { status: 404 });
      const bytes = await history.readFile(commit, rel).catch(() => null);
      if (!bytes) return new Response("Not found", { status: 404 });
      const type = CONTENT_TYPES[path.extname(rel).toLowerCase()] ?? "text/plain; charset=utf-8";
      return new Response(bytes, { headers: { "Content-Type": type, "Content-Security-Policy": "sandbox", "Cache-Control": "private, max-age=31536000, immutable" } });
    },

    "/api/history/pdf": async (req: Request) => {
      if (!trusted(req)) return forbidden();
      const url = new URL(req.url);
      const commit = safeCommit(url.searchParams.get("commit"));
      const rel = safeRel(url.searchParams.get("path"));
      if (!history || !commit || !rel?.endsWith(".tex")) return new Response("Not found", { status: 404 });
      const result = await buildSnapshot(commit, rel);
      if (!result?.ok) {
        return Response.json({ error: "This version doesn't compile", diagnostics: result?.diagnostics ?? [] }, { status: 422 });
      }
      return new Response(Bun.file(result.pdfPath), {
        headers: { "Content-Type": "application/pdf", "Cache-Control": "private, max-age=31536000, immutable" },
      });
    },

    "/api/history/restore": {
      POST: async (req: Request) => {
        if (!trusted(req)) return forbidden();
        const body = (await req.json().catch(() => ({}))) as { commit?: string; path?: string; target?: string };
        const commit = safeCommit(body.commit ?? null);
        const from = safeRel(body.path ?? null);
        const to = safeRel(body.target?.startsWith("latex/") ? body.target.slice("latex/".length) : null);
        if (!history || !commit || !from || !to) return Response.json({ error: "Bad request" }, { status: 400 });
        clearTimeout(editTimer);
        let result: Awaited<ReturnType<HistoryStore["restore"]>>;
        try {
          result = await history.restore(commit, from, to);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 404 });
        }
        if (result === "unchanged") return Response.json({ ok: true, changed: false });
        broadcast({ type: "history" });
        return Response.json({ ok: true, changed: true });
      },
    },

    "/api/export": {
      POST: async (req: Request) => {
        if (!trusted(req)) return forbidden();
        const { doc } = (await req.json()) as { doc?: string };
        if (!doc || !docs.includes(doc) || stateOf(doc).version === 0) {
          return Response.json({ error: "Nothing to export yet — fix the build first." }, { status: 400 });
        }
        const exported = await exportDoc(doc);
        snapshot({ kind: "export", author: "You", label: `Exported ${exported}`, allowEmpty: true, about: relDoc(doc) });
        return Response.json({ path: exported });
      },
    },
  },

  fetch(req, server) {
    const { pathname } = new URL(req.url);
    if (pathname === "/ws" || pathname === "/claude") {
      if (!trusted(req)) return forbidden();
      if (server.upgrade(req, { data: { channel: pathname === "/ws" ? "app" : "claude" } })) return;
    }
    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      if (ws.data.channel === "claude") return claude.attach(ws);
      appClients.add(ws);
      ws.send(treeMessage());
    },
    message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (ws.data.channel === "claude") {
        if (msg.type === "input") claude.input(String(msg.data));
        else if (msg.type === "resize") claude.resize(Number(msg.cols), Number(msg.rows));
        else if (msg.type === "restart") claude.restart(["continue", "new", "resume"].includes(msg.start) ? msg.start : "new");
        return;
      }
      if (msg.type === "open" && docs.includes(msg.doc)) {
        ws.data.doc = msg.doc;
        lastOpened = msg.doc;
        scheduleBrief();
        if (stateOf(msg.doc).last) ws.send(JSON.stringify(compiledMessage(msg.doc)));
        build(msg.doc); // the file may have changed while nobody was looking at it
      } else if (msg.type === "close") {
        ws.data.doc = undefined;
      }
    },
    close(ws) {
      if (ws.data.channel === "claude") claude.detach(ws);
      else appClients.delete(ws);
    },
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    claude.stop();
    // Don't lose edits made in the last few seconds before quitting.
    if (editTimer) await snapshot({ kind: "edit", author: "You", label: (c) => editLabel(c) });
    process.exit(0);
  });
}

const url = `http://localhost:${server.port}`;
console.log(`underleaf → ${url}`);
console.log(`sources   ${LATEX}  (${docs.length} document${docs.length === 1 ? "" : "s"})`);
console.log(`exports   ${RESUMES}`);

if (!flag("--no-open")) {
  const opener = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  Bun.spawn([...opener, url], { stdout: "ignore", stderr: "ignore" });
}
