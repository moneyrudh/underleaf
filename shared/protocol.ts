import type { ClaudeStart, Diagnostic, DirNode, Engine, Snapshot } from "./types";

/**
 * Everything the server and the page say to each other: URLs, websocket messages, and
 * request/response bodies. Both sides import this file, so a change here is checked on both.
 */

// ---------- URLs ----------

export const API = {
  /** GET ?doc=&v= — the latest good PDF of a document (`&download` to save it). */
  pdf: "/api/pdf",
  /** GET ?path= — a file from the tree (`&download` to save it). */
  file: "/api/file",
  /** POST SavedRequest → SavedResponse — record that a document's PDF was saved (a marker in its history). */
  saved: "/api/saved",
  /** POST OpenWorkspaceRequest → OpenWorkspaceResponse — switch to another folder. */
  workspaceOpen: "/api/workspace/open",
  /** POST → PickFolderResponse — show the system's folder dialog (on the machine running underleaf) and open the choice. */
  workspacePick: "/api/workspace/pick",
  /** GET ?path= → HistoryResponse — a file's versions, newest first. */
  history: "/api/history",
  /** GET ?commit=&path= — a file as it was at a snapshot. */
  historyFile: "/api/history/file",
  /** GET ?commit=&path= — a document compiled as it was at a snapshot (422 + HistoryPdfError if it doesn't compile). */
  historyPdf: "/api/history/pdf",
  /** POST RestoreRequest → RestoreResponse. */
  historyRestore: "/api/history/restore",
  /** POST ?event=prompt|stop — Claude Code hooks (needs the X-Underleaf-Token header). */
  claudeHook: "/api/hooks/claude",
} as const;

export const SOCKETS = {
  /** Tree, build and history events (ServerMessage / ClientMessage). */
  app: "/ws",
  /** The Claude terminal: raw terminal bytes down, ClaudeClientMessage up. */
  claude: "/claude",
} as const;

/** A URL with query parameters; undefined values are left out. */
export function url(route: string, params: Record<string, string | number | boolean | undefined> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === true) query.set(key, "");
    else if (value !== undefined && value !== false) query.set(key, String(value));
  }
  const q = query.toString().replace(/=(&|$)/g, "$1"); // flags read better as "&download" than "&download="
  return q ? `${route}?${q}` : route;
}

// ---------- websocket: server → page (/ws) ----------

export type TreeMessage = { type: "tree"; trees: DirNode[]; docs: string[]; roots: Record<string, string>; history: boolean };
export type HistoryMessage = { type: "history" }; // a snapshot was taken: refresh the version list
export type CompilingMessage = { type: "compiling"; doc: string };
export type CompiledMessage = {
  type: "compiled";
  doc: string;
  ok: boolean;
  engine: Engine;
  ms: number;
  pages: number;
  diagnostics: Diagnostic[];
  pdf: string | null; // the latest good PDF, or null if it has never compiled
};
/** Which folder is open, sent on connect and whenever it changes. A tab reloads when the id changes. */
export type WorkspaceMessage = { type: "workspace"; id: string; dir: string; name: string; recent: { dir: string; name: string }[] };
export type ServerMessage = WorkspaceMessage | TreeMessage | HistoryMessage | CompilingMessage | CompiledMessage;

// ---------- websocket: page → server ----------

/** On /ws: which document this tab shows (it then gets that document's build events). */
export type ClientMessage = { type: "open"; doc: string } | { type: "close" };

/** On /claude: keystrokes, terminal size, and restarts. */
export type ClaudeClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "restart"; start: ClaudeStart };

// ---------- request / response bodies ----------

/** `name` is the file name the PDF was saved as (the page can't see the folder). */
export type SavedRequest = { doc: string; name: string; how: "saved" | "downloaded" };
export type SavedResponse = { ok: true } | { error: string };

export type OpenWorkspaceRequest = { dir: string };
export type OpenWorkspaceResponse = { ok: true } | { error: string };
export type PickFolderResponse = { ok: true; dir: string } | { cancelled: true } | { error: string };

export type HistoryResponse = { enabled: boolean; snapshots: Snapshot[] };
export type HistoryPdfError = { error: string; diagnostics: Diagnostic[] };

export type RestoreRequest = { commit: string; path: string; target: string };
export type RestoreResponse = { ok: true; changed: boolean } | { error: string };
