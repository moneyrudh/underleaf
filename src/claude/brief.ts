import path from "node:path";
import { mkdir, stat } from "node:fs/promises";
import type { CompileResult } from "../build/compile";
import type { DirNode, FileNode, TreeNode } from "../../shared/types";

export type BriefInput = {
  latex: DirNode;
  results: Map<string, CompileResult | undefined>; // keyed by "latex/…" doc path
  compiling: Set<string>;
  open: string | null;
};

/**
 * Markdown snapshot of the workspace for the in-app Claude: what exists, whether
 * each document compiles, page counts, and errors. Claude's CLAUDE.md imports it at
 * session start and re-reads it after edits to see compile results.
 */
export function renderBrief({ latex, results, compiling, open }: BriefInput): string {
  const files = (tree: DirNode) => {
    const out: FileNode[] = [];
    const walk = (n: TreeNode) => (n.type === "dir" ? n.children.forEach(walk) : out.push(n));
    walk(tree);
    return out;
  };
  const rel = (p: string) => p.slice(p.indexOf("/") + 1);
  const when = (ms: number) => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  // Memory and Claude's own config are described in its instructions; keep the snapshot about documents.
  const listed = (f: FileNode) => !f.path.startsWith("latex/memory/") && f.path !== "latex/CLAUDE.md";

  const lines = [
    "# Workspace snapshot",
    "",
    "<!-- Written by underleaf; don't edit. Re-read after saving a .tex file to see its compile result. -->",
    "",
    `Open in the preview: ${open ? `\`${rel(open)}\`` : "nothing"}`,
    "",
    "## Documents",
    "",
  ];

  const all = files(latex);
  const docs = all.filter((f) => f.kind === "doc" && listed(f));
  if (docs.length === 0) lines.push("_No documents yet._");
  for (const doc of docs) {
    const r = results.get(doc.path);
    let status: string;
    if (compiling.has(doc.path) && !r) status = "compiling…";
    else if (!r) status = "not compiled yet";
    else if (r.ok) {
      const overfull = r.diagnostics.filter((d) => d.message.startsWith("Overfull")).length;
      status = `✓ ${r.pages} page${r.pages === 1 ? "" : "s"}${overfull ? `, ${overfull} overfull warning${overfull > 1 ? "s" : ""}` : ""}`;
    } else {
      const errors = r.diagnostics.filter((d) => d.severity === "error").slice(0, 3);
      status = `✗ fails to compile: ${errors.map((e) => `${e.file ?? ""}${e.line ? `:${e.line}` : ""} ${e.message}`.trim()).join("; ") || "see logs"}`;
    }
    lines.push(`- \`${rel(doc.path)}\`: ${status} (edited ${when(doc.mtime)})`);
  }

  for (const doc of docs) {
    const overfull = results.get(doc.path)?.diagnostics.filter((d) => d.message.startsWith("Overfull")) ?? [];
    if (overfull.length === 0) continue;
    lines.push("", `Overfull lines in \`${rel(doc.path)}\`:`);
    for (const d of overfull.slice(0, 5)) lines.push(`- ${d.message}`);
  }

  const other = all.filter((f) => f.kind !== "doc" && listed(f));
  if (other.length) {
    lines.push("", "## Other files", "");
    for (const f of other) lines.push(`- \`${rel(f.path)}\``);
  }

  return lines.join("\n") + "\n";
}

let last = "";
export async function writeBrief(latexDir: string, input: BriefInput) {
  if (!(await stat(latexDir).catch(() => null))?.isDirectory()) return; // the folder is gone: don't recreate it
  const text = renderBrief(input);
  if (text === last) return;
  last = text;
  await mkdir(path.join(latexDir, ".underleaf"), { recursive: true });
  await Bun.write(path.join(latexDir, ".underleaf", "workspace.md"), text);
}
