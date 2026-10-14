/** Data types used by both the server (src/) and the page (public/). */

// ---------- files ----------

/** doc = a .tex with \documentclass (compilable); tex = an \input'd fragment. */
export type Kind = "doc" | "tex" | "pdf" | "image" | "text" | "other";
export type FileNode = { type: "file"; name: string; path: string; kind: Kind; size: number; mtime: number };
export type DirNode = { type: "dir"; name: string; path: string; children: TreeNode[] };
export type TreeNode = FileNode | DirNode;

// ---------- builds ----------

export const ENGINES = ["pdflatex", "xelatex", "lualatex"] as const;
export type Engine = (typeof ENGINES)[number];

export type Diagnostic = {
  severity: "error" | "warning";
  file?: string;
  line?: number;
  message: string;
};

// ---------- version history ----------

export type SnapshotKind = "init" | "edit" | "claude" | "export" | "restore";
export type SnapshotAuthor = "You" | "Claude" | "underleaf";

export type Snapshot = {
  id: string;
  time: number; // unix ms
  author: SnapshotAuthor;
  kind: SnapshotKind;
  label: string;
  path?: string; // the file's workspace-relative path at this snapshot (it may have been renamed since)
};

// ---------- Claude ----------

/** How a Claude session starts: pick up the latest conversation, start fresh, or show Claude's picker. */
export const CLAUDE_STARTS = ["continue", "new", "resume"] as const;
export type ClaudeStart = (typeof CLAUDE_STARTS)[number];
