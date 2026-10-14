import type { ServerWebSocket } from "bun";
import { ClaudeSession } from "./claude";
import { LATEX } from "./config";
import { endTurn } from "./snapshots";

/** Open browser tabs, and the one Claude Code session they share. */

export type WsData = { channel: "app" | "claude"; doc?: string };
export const appClients = new Set<ServerWebSocket<WsData>>();

// Claude Code hooks call back into this server; the token only exists in the env we give Claude.
export const HOOK_TOKEN = crypto.randomUUID();
export const claude = new ClaudeSession(LATEX, { UNDERLEAF_HOOK_TOKEN: HOOK_TOKEN }, () => endTurn());

/** Most recent document opened in any tab, for Claude's workspace snapshot. */
export let lastOpened: string | null = null;
export function setLastOpened(doc: string) {
  lastOpened = doc;
}

/** To every tab. */
export function broadcast(msg: object) {
  const payload = JSON.stringify(msg);
  for (const ws of appClients) ws.send(payload);
}

/** To the tabs that have `doc` open. */
export function send(doc: string, msg: object) {
  const payload = JSON.stringify(msg);
  for (const ws of appClients) if (ws.data.doc === doc) ws.send(payload);
}
