import path from "node:path";
import { mkdir } from "node:fs/promises";
import { ENGINES, type Diagnostic, type Engine } from "../../shared/types";

export type CompileResult = {
  ok: boolean;
  engine: Engine;
  pdfPath: string;
  pages: number;
  diagnostics: Diagnostic[];
  ms: number;
};

const HAS_LATEXMK = Bun.which("latexmk") !== null;
const HAS_BIBTEX = Bun.which("bibtex") !== null;

// Unwrapped logs make errors parseable (TeX wraps at 79 chars by default).
const TEX_ENV = { ...process.env, max_print_line: "10000", error_line: "254", half_error_line: "238" };
const TEX_FLAGS = ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error"];

/** `% !TEX program = xelatex` wins; otherwise fontspec/unicode-math imply xelatex. */
export async function detectEngine(texPath: string): Promise<Engine> {
  const src = await Bun.file(texPath).text();
  const magic = src.match(/^%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im)?.[1]?.toLowerCase();
  if (magic && (ENGINES as readonly string[]).includes(magic)) return magic as Engine;
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\b(fontspec|unicode-math)\b/.test(src)) return "xelatex";
  return "pdflatex";
}

export async function compile(texPath: string, outDir: string): Promise<CompileResult> {
  const start = performance.now();
  // The file can vanish between the change that queued this build and now (deleted, moved, its folder trashed).
  if (!(await Bun.file(texPath).exists())) {
    const message = `${path.basename(texPath)} isn't there anymore`;
    return { ok: false, engine: "pdflatex", pdfPath: "", pages: 0, diagnostics: [{ severity: "error", message }], ms: 0 };
  }
  const engine = await detectEngine(texPath).catch(() => "pdflatex" as const);
  const name = path.basename(texPath, ".tex");
  const cwd = path.dirname(texPath);
  const logPath = path.join(outDir, `${name}.log`);
  await mkdir(outDir, { recursive: true });
  // \include{chapters/intro} writes chapters/intro.aux into the output folder, and TeX stops with
  // "can't write" if that subfolder doesn't exist there.
  const src = await readText(texPath);
  for (const [, inc] of src.matchAll(/^[^%\n]*\\include\{([^}]+)\}/gm)) {
    if (inc!.includes("/")) await mkdir(path.join(outDir, path.dirname(inc!)), { recursive: true });
  }

  let ok: boolean;
  const bibWarnings: Diagnostic[] = [];
  if (HAS_LATEXMK) {
    const flag = { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" }[engine];
    ok = await run(["latexmk", flag, ...TEX_FLAGS, `-outdir=${outDir}`, path.basename(texPath)], cwd);
  } else {
    // No latexmk: run BibTeX after the first pass if the document has a bibliography, then rerun
    // the engine until citations and cross-references settle (max 4 passes).
    ok = false;
    let bibDone = !HAS_BIBTEX;
    for (let pass = 0; pass < 4; pass++) {
      ok = await run([engine, ...TEX_FLAGS, `-output-directory=${outDir}`, path.basename(texPath)], cwd);
      if (!ok) break;
      if (!bibDone && /\\bibdata\{/.test(await readText(path.join(outDir, `${name}.aux`)))) {
        bibDone = true;
        // BibTeX runs in the output folder; point it back at the sources for .bib and .bst files.
        const inputs = cwd + path.delimiter;
        await run(["bibtex", name], outDir, { BIBINPUTS: inputs, BSTINPUTS: inputs });
        bibWarnings.push(...parseBlg(await readText(path.join(outDir, `${name}.blg`))));
        continue;
      }
      if (!/Rerun to get|Label\(s\) may have changed|There were undefined citations/.test(await readText(logPath))) break;
    }
  }

  const log = await readText(logPath);
  return {
    ok,
    engine,
    pdfPath: path.join(outDir, `${name}.pdf`),
    pages: Number(log.match(/Output written on .*?\((\d+) pages?/)?.[1] ?? 0),
    diagnostics: [...parseLog(log), ...bibWarnings],
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

/** BibTeX's own problems (a missing .bib, a malformed entry), which the LaTeX log doesn't show. */
export function parseBlg(blg: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const text of blg.split("\n")) {
    const m = text.match(/^(I couldn't open .*|I found no .*|Warning--.*)$/) ?? text.match(/^(.*)---line (\d+) of file (.+)$/);
    if (!m?.[1]?.trim()) continue; // a continuation line ("---line 3 of file x.aux") adds nothing
    const isError = !text.startsWith("Warning--");
    out.push({ severity: isError ? "error" : "warning", file: m[3] ? path.basename(m[3]) : undefined, line: m[2] ? Number(m[2]) : undefined, message: `BibTeX: ${m[1]}` });
  }
  return out;
}

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<boolean> {
  const proc = Bun.spawn(cmd, { cwd, env: { ...TEX_ENV, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

async function readText(file: string): Promise<string> {
  return Bun.file(file).text().catch(() => "");
}
