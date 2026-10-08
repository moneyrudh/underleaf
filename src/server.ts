import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import type { ServerWebSocket } from "bun";
import index from "../public/index.html";
import { compile, ENGINES, REPO, type CompileResult } from "./compile";
import { ClaudeSession } from "./claude";
import { CONTENT_TYPES, documentsIn, keepWatching, resolveTreePath, scanTree, type DirNode } from "./workspace";

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

const treeMessage = () => JSON.stringify({ type: "tree", trees: [latexTree, resumesTree], docs, roots: ROOTS });

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
const claude = new ClaudeSession(LATEX);

function send(doc: string, msg: object) {
  const payload = JSON.stringify(msg);
  for (const ws of appClients) if (ws.data.doc === doc) ws.send(payload);
}

// ---------- watching ----------

let pending: Timer | undefined;
function onFsChange(filename: string) {
  if (/(^|\/)(node_modules|\.git)(\/|$)/.test(filename)) return;
  clearTimeout(pending);
  // Editors (and Claude) often write a file in several steps; wait for things to settle.
  pending = setTimeout(async () => {
    await rescan();
    const payload = treeMessage();
    for (const ws of appClients) ws.send(payload);
    const open = new Set([...appClients].map((ws) => ws.data.doc));
    for (const doc of open) if (doc && docs.includes(doc)) build(doc);
  }, 120);
}

await keepWatching(LATEX, onFsChange);
await keepWatching(RESUMES, onFsChange);
await rescan();

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

    "/api/export": {
      POST: async (req: Request) => {
        if (!trusted(req)) return forbidden();
        const { doc } = (await req.json()) as { doc?: string };
        if (!doc || !docs.includes(doc) || stateOf(doc).version === 0) {
          return Response.json({ error: "Nothing to export yet — fix the build first." }, { status: 400 });
        }
        return Response.json({ path: await exportDoc(doc) });
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
        else if (msg.type === "restart") claude.restart();
        return;
      }
      if (msg.type === "open" && docs.includes(msg.doc)) {
        ws.data.doc = msg.doc;
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
  process.on(signal, () => {
    claude.stop();
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
