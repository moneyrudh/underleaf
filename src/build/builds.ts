import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import { compile, type CompileResult } from "./compile";
import { BUILD, LATEX, RESUMES } from "../server/config";
import { send } from "../server/clients";
import { scheduleBrief } from "../server/trees";
import { API, url, type CompiledMessage } from "../../shared/protocol";

/** Compiling documents: one build at a time per document, the last good PDF kept, exports. */

type DocState = {
  last?: CompileResult;
  version: number; // bumps on every successful build, used to bust the PDF cache
  compiling: boolean;
  queued: boolean;
  builtAt: number; // when the latest build started (its inputs were read at or after this)
};

export const states = new Map<string, DocState>();
export const stateOf = (doc: string) => {
  let s = states.get(doc);
  if (!s) states.set(doc, (s = { version: 0, compiling: false, queued: false, builtAt: 0 }));
  return s;
};

// Last time anything in latex/ changed. A build that started after it is still current.
let latexChangedAt = Date.now();
export function latexChanged() {
  latexChangedAt = Date.now();
}
/** Whether a document needs building before it's shown: never built, or something changed since. */
export const isStale = (doc: string) => {
  const s = stateOf(doc);
  return !s.last || s.builtAt <= latexChangedAt;
};

export const relDoc = (doc: string) => doc.slice("latex/".length);
const outDirOf = (doc: string) => path.join(BUILD, relDoc(doc).replace(/\.tex$/, ""));
// The last successful PDF is kept separately so a broken build never blanks the preview.
export const goodPdfOf = (doc: string) => path.join(outDirOf(doc), "underleaf-latest.pdf");

export async function build(doc: string) {
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
      s.builtAt = Date.now();
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

export function compiledMessage(doc: string): CompiledMessage {
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
    pdf: s.version > 0 ? url(API.pdf, { doc, v: s.version }) : null,
  };
}

/** Exported PDFs mirror the source layout: latex/acme/main.tex → resumes/acme/main.pdf */
export async function exportDoc(doc: string) {
  const dest = path.join(RESUMES, relDoc(doc).replace(/\.tex$/, ".pdf"));
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(goodPdfOf(doc), dest);
  return `resumes/${path.relative(RESUMES, dest)}`;
}
