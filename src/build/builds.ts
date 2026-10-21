import path from "node:path";
import { copyFile, rename } from "node:fs/promises";
import { compile, type CompileResult } from "./compile";
import { current, generation } from "../server/workspace";
import { send } from "../server/clients";
import { scheduleBrief } from "../server/trees";
import { API, url, type CompiledMessage } from "../../shared/protocol";

/** Compiling documents: one build at a time per document, the last good PDF kept. */

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
const outDirOf = (doc: string) => path.join(current().build, relDoc(doc).replace(/\.tex$/, ""));

/** Forget every document's build (the workspace changed). Builds still running are discarded when they finish. */
export function resetBuilds() {
  states.clear();
}
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
      const gen = generation;
      const result = await compile(path.join(current().dir, relDoc(doc)), outDirOf(doc));
      if (gen !== generation) return; // the workspace changed meanwhile: this build belongs to the old one
      if (result.ok) {
        // Copy beside it, then rename over it (atomic): a page fetching the PDF mid-copy gets the old
        // one or the new one, never a truncated file it might save somewhere.
        const good = goodPdfOf(doc);
        await copyFile(result.pdfPath, `${good}.tmp`);
        await rename(`${good}.tmp`, good);
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
