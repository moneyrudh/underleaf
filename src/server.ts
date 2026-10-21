import { ENGINES } from "../shared/types";
import { DEFAULT_DIR, OPEN_BROWSER, START_DIR } from "./server/config";
import { claude } from "./server/clients";
import { flushEditSnapshot } from "./history/snapshots";
import { canonical, openWorkspace, unusable } from "./server/workspace";
import { startServer } from "./server/routes";
import { recentWorkspaces } from "./workspace/registry";

/**
 * Startup. The pieces:
 *   server/     config (args), workspace (the open folder and switching), routes (HTTP + websockets),
 *               clients (tabs and the shared Claude session), watch (files changing), trees (the file tree)
 *   build/      compile (one LaTeX build), builds (per-document queue, last good PDF)
 *   history/    store (git-backed snapshots), snapshots (when they're taken)
 *   workspace/  files (scanning, kinds, watching), seed (templates, Claude hooks), registry (recent
 *               folders), pick (the system folder dialog)
 *   claude/     session (the claude CLI in a PTY), brief (workspace.md for Claude)
 * Types and messages shared with the page live in ../shared/.
 */

if (!ENGINES.some((e) => Bun.which(e))) {
  console.error("No LaTeX engine found (pdflatex / xelatex / lualatex). Run `bun run doctor` for install steps.");
  process.exit(1);
}

// The folder named on the command line, else the last one you had open, else this checkout's latex/.
const startDir = await canonical(START_DIR ?? (await recentWorkspaces())[0] ?? DEFAULT_DIR);
const problem = startDir === (await canonical(DEFAULT_DIR)) ? null : await unusable(startDir);
if (problem) {
  console.error(problem);
  process.exit(1);
}

await openWorkspace(startDir); // before serving, so every tab connects to an open workspace
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

if (OPEN_BROWSER) {
  const opener = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  Bun.spawn([...opener, url], { stdout: "ignore", stderr: "ignore" });
}
