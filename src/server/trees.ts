import { writeBrief } from "../claude/brief";
import { states } from "../build/builds";
import { lastOpened } from "./clients";
import { history } from "../history/snapshots";
import { current } from "./workspace";
import { documentsIn, scanTree } from "../workspace/files";
import type { DirNode } from "../../shared/types";
import type { TreeMessage } from "../../shared/protocol";

/** The open workspace's file tree and the documents in it. */

export let latexTree: DirNode;
/** Compilable documents, as tree paths ("latex/main.tex"). */
export let docs: string[] = [];

export async function rescan() {
  latexTree = await scanTree(current().dir, "latex");
  docs = documentsIn(latexTree).map((d) => `latex/${d}`);
}

export const treeMessage = (): TreeMessage => ({ type: "tree", trees: [latexTree], docs, roots: current().roots, history: history !== null });

// ---------- workspace snapshot for Claude (<workspace>/.underleaf/workspace.md) ----------

let briefTimer: Timer | undefined;
export function scheduleBrief() {
  clearTimeout(briefTimer);
  briefTimer = setTimeout(() => {
    const results = new Map(docs.map((d) => [d, states.get(d)?.last]));
    const compiling = new Set(docs.filter((d) => states.get(d)?.compiling));
    writeBrief(current().dir, { latex: latexTree, results, compiling, open: lastOpened });
  }, 150);
}
