import path from "node:path";
import { mkdir } from "node:fs/promises";

export type Engine = "pdflatex" | "xelatex" | "lualatex";

export type Diagnostic = {
  severity: "error" | "warning";
  file?: string;
  line?: number;
  message: string;
};

export type CompileResult = {
  ok: boolean;
  engine: Engine;
  pdfPath: string;
  pages: number;
  diagnostics: Diagnostic[];
  ms: number;
};

export const REPO = path.resolve(import.meta.dir, "..");
export const ENGINES: Engine[] = ["pdflatex", "xelatex", "lualatex"];
const HAS_LATEXMK = Bun.which("latexmk") !== null;

// Unwrapped logs make errors parseable (TeX wraps at 79 chars by default).
const TEX_ENV = { ...process.env, max_print_line: "10000", error_line: "254", half_error_line: "238" };
const TEX_FLAGS = ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error"];

/** `% !TEX program = xelatex` wins; otherwise fontspec/unicode-math imply xelatex. */
export async function detectEngine(texPath: string): Promise<Engine> {
  const src = await Bun.file(texPath).text();
  const magic = src.match(/^%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im)?.[1]?.toLowerCase();
  if (magic && (ENGINES as string[]).includes(magic)) return magic as Engine;
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\b(fontspec|unicode-math)\b/.test(src)) return "xelatex";
  return "pdflatex";
}

export async function compile(texPath: string, outDir: string): Promise<CompileResult> {
  const start = performance.now();
  const engine = await detectEngine(texPath);
  const name = path.basename(texPath, ".tex");
  const cwd = path.dirname(texPath);
  const logPath = path.join(outDir, `${name}.log`);
  await mkdir(outDir, { recursive: true });

  let ok: boolean;
  if (HAS_LATEXMK) {
    const flag = { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" }[engine];
    ok = await run(["latexmk", flag, ...TEX_FLAGS, `-outdir=${outDir}`, path.basename(texPath)], cwd);
  } else {
    // No latexmk: rerun the engine until cross-references settle (max 3 passes).
    ok = false;
    for (let pass = 0; pass < 3; pass++) {
      ok = await run([engine, ...TEX_FLAGS, `-output-directory=${outDir}`, path.basename(texPath)], cwd);
      if (!ok || !/Rerun to get|Label\(s\) may have changed/.test(await readText(logPath))) break;
    }
  }

  const log = await readText(logPath);
  return {
    ok,
    engine,
    pdfPath: path.join(outDir, `${name}.pdf`),
    pages: Number(log.match(/Output written on .*?\((\d+) pages?/)?.[1] ?? 0),
    diagnostics: parseLog(log),
    ms: Math.round(performance.now() - start),
  };
}

export function parseLog(log: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    const fileLine = text.match(/^(.*?\.\w+):(\d+): (.*)$/);
    if (fileLine?.[3]?.includes("==> Fatal error occurred")) continue; // restates the error above it
    if (fileLine) {
      // TeX prints the offending source as "l.42 \foo" a few lines below.
      const context = lines.slice(i + 1, i + 6).find((l) => /^l\.\d+ /.test(l));
      const message = context ? `${fileLine[3]}  —  ${context.replace(/^l\.\d+ /, "").trim()}` : fileLine[3]!;
      out.push({ severity: "error", file: path.basename(fileLine[1]!), line: Number(fileLine[2]), message });
    } else if (text.startsWith("! ")) {
      out.push({ severity: "error", message: text.slice(2) });
    } else if (/^(LaTeX|Package \w+) Warning:/.test(text)) {
      const line = text.match(/on input line (\d+)/)?.[1];
      out.push({ severity: "warning", line: line ? Number(line) : undefined, message: text });
    } else if (text.startsWith("Overfull \\hbox")) {
      // Overfull boxes are the usual cause of text running into the margin.
      const line = text.match(/at lines? (\d+)/)?.[1];
      out.push({ severity: "warning", line: line ? Number(line) : undefined, message: text });
    }
  }
  return out;
}

async function run(cmd: string[], cwd: string): Promise<boolean> {
  const proc = Bun.spawn(cmd, { cwd, env: TEX_ENV, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

async function readText(file: string): Promise<string> {
  return Bun.file(file).text().catch(() => "");
}
