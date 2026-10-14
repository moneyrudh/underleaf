import path from "node:path";
import { ENGINES } from "../shared/types";
import { REPO } from "./repo";
import { LATEX, OPEN_BROWSER, PORT, RESUMES } from "./server/config";
import { build } from "./build/builds";
import { claude } from "./server/clients";
import { flushEditSnapshot, openHistory } from "./history/snapshots";
import { docs, rescan, scheduleBrief } from "./server/trees";
import { startWatching } from "./server/watch";
import { startServer } from "./server/routes";
import { ensureClaudeHooks, seedWorkspace } from "./workspace/seed";

/**
 * Startup. The pieces:
 *   server/     config (args, folders), routes (HTTP + websockets), clients (tabs and the
 *               shared Claude session), watch (files changing on disk), trees (scanned folders)
 *   build/      compile (one LaTeX build), builds (per-document queue, last good PDF, export)
 *   history/    store (git-backed snapshots), snapshots (when they're taken)
 *   workspace/  files (scanning, kinds, watching), seed (templates, Claude hooks)
 *   claude/     session (the claude CLI in a PTY), brief (workspace.md for Claude)
 * Types and messages shared with the page live in ../shared/.
 */

if (!ENGINES.some((e) => Bun.which(e))) {
  console.error("No LaTeX engine found (pdflatex / xelatex / lualatex). Run `bun run doctor` for install steps.");
  process.exit(1);
}

await seedWorkspace(LATEX, path.join(REPO, "templates"));
// Hooks first, so the settings change is part of the first snapshot rather than looking like an edit.
if (Bun.which("git")) await ensureClaudeHooks(LATEX, `http://127.0.0.1:${PORT}`);
await openHistory();
await startWatching();
await rescan();
scheduleBrief();

// Compile everything once in the background so Claude starts with real page counts.
(async () => {
  for (const doc of docs) await build(doc);
})();

const server = startServer();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    claude.stop();
    await flushEditSnapshot();
    process.exit(0);
  });
}

const url = `http://localhost:${server.port}`;
console.log(`underleaf → ${url}`);
console.log(`sources   ${LATEX}  (${docs.length} document${docs.length === 1 ? "" : "s"})`);
console.log(`exports   ${RESUMES}`);

if (OPEN_BROWSER) {
  const opener = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  Bun.spawn([...opener, url], { stdout: "ignore", stderr: "ignore" });
}
