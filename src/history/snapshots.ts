import path from "node:path";
import { compile, type CompileResult } from "../build/compile";
import { BUILD, LATEX } from "../server/config";
import { HistoryStore, editLabel } from "./store";
import { broadcast } from "../server/clients";
import type { Snapshot } from "../../shared/types";

/**
 * When snapshots are taken. They land in ~/.underleaf/history/<workspace id>.git. Three triggers:
 *   • a Claude turn ends (Stop hook)          → "Claude: <prompt>"
 *   • you stop editing for EDIT_IDLE_MS         → "You edited main.tex"
 *   • Save PDF                                  → "Exported resumes/…"
 */

const EDIT_IDLE_MS = 10_000;
const TURN_STALE_MS = 30 * 60_000; // a turn with no Stop (crash, killed process) stops counting after this

/** null when git isn't installed (the app runs without history). */
export let history: HistoryStore | null = null;
let turn: { prompt: string; since: number } | null = null;
let editTimer: Timer | undefined;

export async function openHistory() {
  history = await HistoryStore.open(LATEX).catch((e) => {
    console.error(`history disabled: ${(e as Error).message}`);
    return null;
  });
  if (!history) console.log("history   disabled (git not found)");
}

function claudeIsWorking() {
  if (turn && Date.now() - turn.since > TURN_STALE_MS) turn = null;
  return turn !== null;
}

/** The Claude process exited or was replaced: whatever turn it was in is over. */
export function endTurn() {
  turn = null;
}

export async function snapshot(req: Parameters<HistoryStore["snapshot"]>[0]): Promise<Snapshot | null> {
  if (!history) return null;
  try {
    const snap = await history.snapshot(req);
    if (snap) {
      broadcast({ type: "history" });
      console.log(`◷ ${snap.label}`);
    }
    return snap;
  } catch (e) {
    console.error(`history: ${(e as Error).message}`);
    return null;
  }
}

/** Your edits are grouped: one snapshot once you've paused. Claude's are grouped per turn instead. */
export function scheduleEditSnapshot() {
  clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    editTimer = undefined;
    if (!claudeIsWorking()) snapshot({ kind: "edit", author: "You", label: (c) => editLabel(c) });
  }, EDIT_IDLE_MS);
}

/** A restore records its own snapshots; drop the pending edit snapshot so it isn't taken twice. */
export function cancelEditSnapshot() {
  clearTimeout(editTimer);
}

/** On quit: don't lose edits made in the last few seconds. */
export async function flushEditSnapshot() {
  if (editTimer) await snapshot({ kind: "edit", author: "You", label: (c) => editLabel(c) });
}

function claudeLabel(prompt: string | undefined, changed: string[]) {
  const line = prompt?.split("\n").find((l) => l.trim())?.trim();
  if (!line) return editLabel(changed, "Claude edited");
  return `Claude: ${line.length > 72 ? line.slice(0, 71) + "…" : line}`;
}

export async function onClaudeHook(event: string, body: { prompt?: string }) {
  if (event === "prompt") {
    turn = { prompt: body.prompt ?? "", since: Date.now() };
  } else if (event === "stop") {
    const prompt = turn?.prompt;
    turn = null;
    clearTimeout(editTimer); // this snapshot covers any pending edits too
    await snapshot({ kind: "claude", author: "Claude", label: (c) => claudeLabel(prompt, c) });
  }
}

/** Compiled PDFs of past versions, one build per (snapshot, document). */
const HISTORY_BUILD = path.join(BUILD, ".history");
const historyBuilds = new Map<string, Promise<CompileResult | null>>();

export function buildSnapshot(commit: string, rel: string): Promise<CompileResult | null> {
  const key = `${commit}:${rel}`;
  let pending = historyBuilds.get(key);
  if (!pending) {
    pending = (async () => {
      const root = path.join(HISTORY_BUILD, commit);
      const src = path.join(root, "src");
      if (!(await Bun.file(path.join(src, rel)).exists())) await history!.exportTree(commit, src);
      return compile(path.join(src, rel), path.join(root, "out", rel.replace(/\.tex$/, "")));
    })().catch((e) => {
      console.error(`history: ${(e as Error).message}`);
      return null;
    });
    historyBuilds.set(key, pending);
    pending.then((r) => !r?.ok && historyBuilds.delete(key)); // retry failures next time
  }
  return pending;
}
