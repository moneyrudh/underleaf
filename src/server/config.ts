import path from "node:path";
import { REPO } from "../repo";

// Usage: bun dev [folder] [--port 4747] [--no-open]
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--port$/));

/** The folder named on the command line, if any; otherwise underleaf reopens the last one. */
export const START_DIR = positional[0] ? path.resolve(positional[0]) : null;
/** Where a fresh checkout keeps its documents (git-ignored). Gets the starter setup on first run. */
export const DEFAULT_DIR = path.join(REPO, "latex");
export const PORT = Number(option("--port") ?? process.env.PORT ?? 4747);
export const OPEN_BROWSER = !args.includes("--no-open");
