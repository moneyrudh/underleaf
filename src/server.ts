import path from "node:path";
import { ENGINES, REPO } from "./compile";
import { LATEX, OPEN_BROWSER, PORT, RESUMES } from "./config";
import { build } from "./builds";
import { claude } from "./clients";
import { flushEditSnapshot, openHistory } from "./snapshots";
import { docs, rescan, scheduleBrief } from "./trees";
import { startWatching } from "./watch";
import { startServer } from "./routes";
import { ensureClaudeHooks, seedWorkspace } from "./workspace";

/**
 * Startup. The pieces:
 *   config.ts     arguments and folders
 *   trees.ts      the scanned folders, and the workspace brief for Claude
 *   builds.ts     compiling documents, last good PDFs, export
 *   snapshots.ts  when version history snapshots are taken
 *   watch.ts      reacting to files changing on disk
 *   clients.ts    browser tabs and the shared Claude Code session
 *   routes.ts     HTTP and websockets
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
