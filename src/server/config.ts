import path from "node:path";
import { REPO } from "../repo";

// Usage: bun dev [latex-dir] [--resumes dir] [--port 4747] [--no-open]
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(port|resumes)$/));

export const LATEX = path.resolve(positional[0] ?? path.join(REPO, "latex"));
export const RESUMES = path.resolve(option("--resumes") ?? path.join(REPO, "resumes"));
export const BUILD = path.join(REPO, "build", path.basename(LATEX));
export const PORT = Number(option("--port") ?? process.env.PORT ?? 4747);
export const OPEN_BROWSER = !args.includes("--no-open");
/** Sidebar paths start with one of these keys, e.g. "latex/main.tex". */
export const ROOTS = { latex: LATEX, resumes: RESUMES };
