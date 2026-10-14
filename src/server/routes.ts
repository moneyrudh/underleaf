import path from "node:path";
import index from "../../public/index.html";
import { REPO } from "../repo";
import { PORT, ROOTS } from "./config";
import { build, compiledMessage, exportDoc, goodPdfOf, isStale, relDoc, stateOf } from "../build/builds";
import { appClients, broadcast, claude, HOOK_TOKEN, setLastOpened, type WsData } from "./clients";
import { buildSnapshot, cancelEditSnapshot, history, onClaudeHook, snapshot } from "../history/snapshots";
import { docs, scheduleBrief, treeMessage } from "./trees";
import type { HistoryStore } from "../history/store";
import { CONTENT_TYPES, resolveTreePath } from "../workspace/files";
import { CLAUDE_STARTS } from "../../shared/types";
import {
  API,
  SOCKETS,
  type ClaudeClientMessage,
  type ClientMessage,
  type ExportRequest,
  type ExportResponse,
  type HistoryPdfError,
  type HistoryResponse,
  type RestoreRequest,
  type RestoreResponse,
} from "../../shared/protocol";

/** HTTP routes and websockets. Everything is local-only: see trusted(). */

// Workspace-relative path inside latex/, with no way to climb out of it.
const safeRel = (p: string | null) =>
  p && !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes("..") ? p : null;
const safeCommit = (c: string | null) => (c && /^[0-9a-f]{7,40}$/.test(c) ? c : null);

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

export function startServer() {
  return Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: PORT,
    // Bun's dev mode (HMR + browser errors echoed to this terminal) is only useful when
    // hacking on underleaf's UI; otherwise it relays noise from browser extensions.
    development: process.env.UNDERLEAF_DEV === "1",
    routes: {
      "/": index,
      "/pdf.worker.mjs": () => new Response(Bun.file(workerPath), { headers: { "Content-Type": "text/javascript" } }),

      [API.pdf]: (req: Request) => {
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

      [API.file]: async (req: Request) => {
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

      [API.claudeHook]: {
        POST: async (req: Request) => {
          if (!trusted(req) || req.headers.get("x-underleaf-token") !== HOOK_TOKEN) return forbidden();
          const event = new URL(req.url).searchParams.get("event") ?? "";
          await onClaudeHook(event, await req.json().catch(() => ({})));
          return new Response(null, { status: 204 }); // empty body: nothing gets added to Claude's context
        },
      },

      [API.history]: (req: Request) => {
        if (!trusted(req)) return forbidden();
        const treePath = new URL(req.url).searchParams.get("path") ?? "";
        const rel = safeRel(treePath.startsWith("latex/") ? treePath.slice("latex/".length) : null);
        if (!history || !rel) return Response.json({ enabled: history !== null, snapshots: [] } satisfies HistoryResponse);
        return history.log(rel).then((snapshots) => Response.json({ enabled: true, snapshots } satisfies HistoryResponse));
      },

      [API.historyFile]: async (req: Request) => {
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

      [API.historyPdf]: async (req: Request) => {
        if (!trusted(req)) return forbidden();
        const url = new URL(req.url);
        const commit = safeCommit(url.searchParams.get("commit"));
        const rel = safeRel(url.searchParams.get("path"));
        if (!history || !commit || !rel?.endsWith(".tex")) return new Response("Not found", { status: 404 });
        const result = await buildSnapshot(commit, rel);
        if (!result?.ok) {
          return Response.json({ error: "This version doesn't compile", diagnostics: result?.diagnostics ?? [] } satisfies HistoryPdfError, { status: 422 });
        }
        return new Response(Bun.file(result.pdfPath), {
          headers: { "Content-Type": "application/pdf", "Cache-Control": "private, max-age=31536000, immutable" },
        });
      },

      [API.historyRestore]: {
        POST: async (req: Request) => {
          if (!trusted(req)) return forbidden();
          const body = (await req.json().catch(() => ({}))) as Partial<RestoreRequest>;
          const commit = safeCommit(body.commit ?? null);
          const from = safeRel(body.path ?? null);
          const to = safeRel(body.target?.startsWith("latex/") ? body.target.slice("latex/".length) : null);
          if (!history || !commit || !from || !to) return Response.json({ error: "Bad request" } satisfies RestoreResponse, { status: 400 });
          cancelEditSnapshot();
          let result: Awaited<ReturnType<HistoryStore["restore"]>>;
          try {
            result = await history.restore(commit, from, to);
          } catch (e) {
            return Response.json({ error: (e as Error).message } satisfies RestoreResponse, { status: 404 });
          }
          if (result === "unchanged") return Response.json({ ok: true, changed: false } satisfies RestoreResponse);
          broadcast({ type: "history" });
          return Response.json({ ok: true, changed: true } satisfies RestoreResponse);
        },
      },

      [API.export]: {
        POST: async (req: Request) => {
          if (!trusted(req)) return forbidden();
          const { doc } = (await req.json().catch(() => ({}))) as Partial<ExportRequest>;
          if (!doc || !docs.includes(doc) || stateOf(doc).version === 0) {
            return Response.json({ error: "Nothing to export yet — fix the build first." } satisfies ExportResponse, { status: 400 });
          }
          const exported = await exportDoc(doc);
          snapshot({ kind: "export", author: "You", label: `Exported ${exported}`, allowEmpty: true, about: relDoc(doc) });
          return Response.json({ path: exported } satisfies ExportResponse);
        },
      },
    },

    fetch(req, server) {
      const { pathname } = new URL(req.url);
      if (pathname === SOCKETS.app || pathname === SOCKETS.claude) {
        if (!trusted(req)) return forbidden();
        if (server.upgrade(req, { data: { channel: pathname === SOCKETS.app ? "app" : "claude" } })) return;
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
        if (ws.data.channel === "claude") {
          const msg = JSON.parse(String(raw)) as ClaudeClientMessage;
          if (msg.type === "input") claude.input(String(msg.data));
          else if (msg.type === "resize") claude.resize(Number(msg.cols), Number(msg.rows));
          else if (msg.type === "restart") claude.restart(CLAUDE_STARTS.includes(msg.start) ? msg.start : "new");
          return;
        }
        const msg = JSON.parse(String(raw)) as ClientMessage;
        if (msg.type === "open" && docs.includes(msg.doc)) {
          ws.data.doc = msg.doc;
          setLastOpened(msg.doc);
          scheduleBrief();
          const s = stateOf(msg.doc);
          if (s.last) ws.send(JSON.stringify(compiledMessage(msg.doc)));
          // Rebuild only if something changed since the last build: an identical rebuild would
          // re-render the same PDF (a second flash) for nothing.
          if (isStale(msg.doc)) build(msg.doc); // a running build reports to this tab anyway
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
}
