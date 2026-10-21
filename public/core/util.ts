export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Every localStorage key the page uses (stored as "underleaf:<key>"). Don't change the
 * strings: that would forget what people saved.
 */
export const STORED = {
  selected: "selected", // the open file
  recent: "recent", // recently opened files, for quick-open ranking
  expanded: "expanded", // open folders in the tree
  showAgentFiles: "show-agent-files",
  versionStrip: "version-strip", // version bar shown
  // Panes shown ("1"/"0"), keyed by the pane's element id.
  treePane: "tree-pane",
  claudePane: "claude-pane",
  previewPane: "preview-pane",
} as const;
/** A key from STORED, or a splitter width keyed by its CSS variable ("--tree-w"). */
export type StoredKey = (typeof STORED)[keyof typeof STORED] | `--${string}`;

/** localStorage that never throws (private windows, blocked storage). */
/** Keys that belong to one workspace (its files), stored separately per workspace. */
const PER_WORKSPACE = new Set<string>([STORED.selected, STORED.recent, STORED.expanded]);
let scope = "";

/** Set once the server says which workspace is open, before anything reads a per-workspace key. */
export function setStorageScope(workspaceId: string) {
  scope = workspaceId;
}

export function storage(key: StoredKey, value?: string): string | null {
  const name = PER_WORKSPACE.has(key) ? `underleaf:${scope}:${key}` : `underleaf:${key}`;
  try {
    if (value !== undefined) localStorage.setItem(name, value);
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

let toastTimer: ReturnType<typeof setTimeout>;
export function toast(text: string) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

export function formatBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
