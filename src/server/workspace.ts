import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { DEFAULT_DIR, PORT } from "./config";
import { REPO } from "../repo";
import { HOME } from "../home";
import { broadcast, claude } from "./clients";
import { resetBuilds } from "../build/builds";
import { closeHistory, flushEditSnapshot, openHistory } from "../history/snapshots";
import { workspaceId } from "../history/store";
import { docs, rescan, scheduleBrief, treeMessage } from "./trees";
import { startWatching, stopWatching } from "./watch";
import { ensureClaudeHooks, seedWorkspace } from "../workspace/seed";
import { recentWorkspaces, rememberWorkspace } from "../workspace/registry";
import { build } from "../build/builds";
import type { WorkspaceMessage } from "../../shared/protocol";

/**
 * The open workspace: one folder with its documents, history, build cache and Claude session.
 * Switching closes everything tied to the old folder and opens the new one.
 */

export type Workspace = {
  dir: string;
  id: string; // stable, stored in <dir>/.underleaf/id
  name: string;
  build: string; // build output, outside the folder
  roots: Record<string, string>; // tree root key → folder ("latex/…" paths)
};

export let active: Workspace | null = null;
/** Bumps on every switch, so work started for the old folder can tell it's stale. */
export let generation = 0;

export function current(): Workspace {
  if (!active) throw new Error("no workspace open");
  return active;
}

/** Why a folder can't be a workspace, or null if it can. */
export async function unusable(dir: string): Promise<string | null> {
  if (!path.isAbsolute(dir)) return "Use a full path to the folder.";
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) return `${dir} isn't a folder.`;
  const home = os.homedir();
  // Folders that would mean watching and versioning far too much, or underleaf itself.
  const tooBroad = [path.parse(dir).root, home, path.join(home, "Desktop"), path.join(home, "Documents"), path.join(home, "Downloads")];
  if (tooBroad.includes(dir)) return `${dir} is too broad to open as a workspace. Pick the folder for one project.`;
  if (dir === REPO || dir === HOME || dir.startsWith(HOME + path.sep)) return "That's underleaf's own folder. Pick a folder for your documents.";
  if (REPO.startsWith(dir + path.sep)) return `${dir} contains underleaf itself. Pick the folder for one project.`;
  return null;
}

let switching: Promise<void> = Promise.resolve();

/** Open `dir` as the workspace (serialized: two quick switches never interleave). */
export function openWorkspace(dir: string): Promise<void> {
  const next = switching.then(() => open(dir));
  switching = next.catch(() => {});
  return next;
}

async function open(dir: string) {
  if (active?.dir === dir) return;
  const previous = active;
  if (previous) {
    await flushEditSnapshot(); // don't lose the old folder's last edits
    stopWatching();
    closeHistory();
    resetBuilds();
  }
  generation++;

  // A fresh checkout's own documents folder gets the starter setup; folders you open get only what
  // underleaf needs to work in them (.underleaf/ and the Claude hooks).
  if (dir === DEFAULT_DIR) await seedWorkspace(dir, path.join(REPO, "templates"));
  if (Bun.which("git")) await ensureClaudeHooks(dir, `http://127.0.0.1:${PORT}`);

  const id = await workspaceId(dir);
  active = { dir, id, name: path.basename(dir), build: path.join(REPO, "build", id), roots: { latex: dir } };
  await openHistory(dir);
  await startWatching(dir);
  await rescan();
  scheduleBrief();
  await rememberWorkspace(dir);
  if (previous) claude.moveTo(dir); // Claude picks up this folder's last conversation
  else claude.setCwd(dir);

  broadcast(await workspaceMessage());
  broadcast(treeMessage());
  console.log(`workspace ${dir}  (${docs.length} document${docs.length === 1 ? "" : "s"})`);

  // Compile everything once in the background so Claude starts with real page counts.
  const gen = generation;
  (async () => {
    for (const doc of docs) if (gen === generation) await build(doc);
  })();
}

export async function workspaceMessage(): Promise<WorkspaceMessage> {
  const w = current();
  const recent = (await recentWorkspaces()).map((dir) => ({ dir, name: path.basename(dir) }));
  return { type: "workspace", id: w.id, dir: w.dir, name: w.name, recent };
}
