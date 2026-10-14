import { writeBrief } from "../claude/brief";
import { LATEX, RESUMES, ROOTS } from "./config";
import { states } from "../build/builds";
import { lastOpened } from "./clients";
import { history } from "../history/snapshots";
import { documentsIn, scanTree } from "../workspace/files";
import type { DirNode } from "../../shared/types";
import type { TreeMessage } from "../../shared/protocol";

/** The scanned latex/ and resumes/ folders, and the documents in them. */

export let latexTree: DirNode;
export let resumesTree: DirNode;
/** Compilable documents, as tree paths ("latex/main.tex"). */
export let docs: string[] = [];

export async function rescan() {
  latexTree = await scanTree(LATEX, "latex");
  resumesTree = await scanTree(RESUMES, "resumes");
  docs = documentsIn(latexTree).map((d) => `latex/${d}`);
}

export const treeMessage = () =>
  JSON.stringify({ type: "tree", trees: [latexTree, resumesTree], docs, roots: ROOTS, history: history !== null } satisfies TreeMessage);

// ---------- workspace snapshot for Claude (latex/.underleaf/workspace.md) ----------

let briefTimer: Timer | undefined;
export function scheduleBrief() {
  clearTimeout(briefTimer);
  briefTimer = setTimeout(() => {
    const results = new Map(docs.map((d) => [d, states.get(d)?.last]));
    const compiling = new Set(docs.filter((d) => states.get(d)?.compiling));
    writeBrief(LATEX, { latex: latexTree, resumes: resumesTree, results, compiling, open: lastOpened });
  }, 150);
}
