import os from "node:os";
import path from "node:path";
import { access, constants, realpath, stat } from "node:fs/promises";
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

/** A folder's real path (symlinks resolved, letter case as on disk), so checks and ids compare like with like. */
export const canonical = (dir: string) => realpath(dir).catch(() => dir);

/** Why a folder can't be a workspace, or null if it can. `dir` should come from `canonical`. */
export async function unusable(dir: string): Promise<string | null> {
  if (!path.isAbsolute(dir)) return "Use a full path to the folder.";
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) return `${dir} isn't a folder.`;
  const [home, repo, own] = await Promise.all([canonical(os.homedir()), canonical(REPO), canonical(HOME)]);
  const inside = (parent: string) => dir === parent || dir.startsWith(parent + path.sep);
  // Folders that would mean watching and versioning far too much, or underleaf itself.
  const tooBroad = [path.parse(dir).root, home, path.join(home, "Desktop"), path.join(home, "Documents"), path.join(home, "Downloads")];
  if (tooBroad.includes(dir)) return `${dir} is too broad to open as a workspace. Pick the folder for one project.`;
  if (repo.startsWith(dir + path.sep)) return `${dir} contains underleaf itself. Pick the folder for one project.`;
  // Inside the checkout only its own documents folder and the examples work: anything else is
  // underleaf's source or templates, and opening it would write ids and hooks into committed files.
  const allowed = [await canonical(DEFAULT_DIR), path.join(repo, "examples")];
  if ((inside(repo) && !allowed.includes(dir)) || inside(own)) return "That's underleaf's own folder. Pick a folder for your documents.";
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

  // Everything that can fail for the new folder (it's read-only, say) happens before the old one
  // is closed, so a refused switch leaves the old workspace running as it was.
  // A fresh checkout's own documents folder gets the starter setup; folders you open get only what
  // underleaf needs to work in them (.underleaf/ and the Claude hooks).
  const isDefault = dir === (await canonical(DEFAULT_DIR));
  if (isDefault) await seedWorkspace(dir, path.join(REPO, "templates"));
  if (Bun.which("git")) await ensureClaudeHooks(dir, `http://127.0.0.1:${PORT}`);
  const id = await workspaceId(dir);

  const previous = active;
  if (previous) {
    await flushEditSnapshot(); // don't lose the old folder's last edits
    stopWatching();
    closeHistory();
    resetBuilds();
  }
  generation++;

  active = { dir, id, name: path.basename(dir), build: path.join(REPO, "build", id), roots: { latex: dir } };
  await openHistory(dir);
  await startWatching(dir, isDefault);
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

/** Open `dir`, or say why not (refused, or it failed partway and the old workspace stayed open). */
export async function tryOpenWorkspace(requested: string): Promise<string | null> {
  const dir = await canonical(requested);
  const problem = await unusable(dir);
  if (problem) return problem;
  if (!(await access(dir, constants.W_OK).then(() => true, () => false))) {
    return `underleaf can't write to ${dir}. It needs to add a small .underleaf/ folder there; check the folder's permissions.`;
  }
  try {
    await openWorkspace(dir);
    return null;
  } catch (e) {
    console.error(`couldn't open ${dir}: ${(e as Error).message}`);
    return `Couldn't open ${dir}: ${(e as Error).message}`;
  }
}

export async function workspaceMessage(): Promise<WorkspaceMessage> {
  const w = current();
  const recent = (await recentWorkspaces()).map((dir) => ({ dir, name: path.basename(dir) }));
  return { type: "workspace", id: w.id, dir: w.dir, name: w.name, recent };
}
