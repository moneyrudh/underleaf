import os from "node:os";
import path from "node:path";
import { access, constants, mkdir, realpath, stat } from "node:fs/promises";
import { DEFAULT_DIR, PORT } from "./config";
import { REPO } from "../repo";
import { BUILD, HOME } from "../home";
import { cleanName, copyIntoLibrary, createProject, inLibrary, listProjects, nameOf, renameProject } from "../workspace/library";
import { broadcast, claude } from "./clients";
import { resetBuilds } from "../build/builds";
import { closeHistory, flushEditSnapshot, openHistory } from "../history/snapshots";
import { forkWorkspaceId, workspaceId } from "../history/store";
import { docs, rescan, scheduleBrief, treeMessage } from "./trees";
import { startWatching, stopWatching } from "./watch";
import { ensureClaudeSettings } from "../workspace/claude-settings";
import { applyTemplate, claudeMdImportsInstructions, isEmptyWorkspace, writeInstructions } from "../workspace/templates";
import { copiedFrom, recentWorkspaces, rememberWorkspace } from "../workspace/registry";
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
  if ((inside(repo) && !allowed.includes(dir)) || (inside(own) && !inLibrary(dir))) return "That's underleaf's own folder. Pick a folder for your documents.";
  return null;
}

let switching: Promise<unknown> = Promise.resolve();

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
  // underleaf adds only what it needs to work in a folder: .underleaf/ (id, instructions, status)
  // and its hooks and guardrails in .claude/settings.json. An empty folder offers the templates.
  const isDefault = dir === (await canonical(DEFAULT_DIR));
  if (isDefault) await mkdir(dir, { recursive: true }); // a fresh checkout has no latex/ yet
  await ensureClaudeSettings(dir, hookBase(), { insideCheckout: isDefault });
  const instructions = await writeInstructions(dir);
  let id = await workspaceId(dir);
  // A copy would otherwise share the original's history, build folder and the page's saved state.
  const original = await copiedFrom(dir, id);
  if (original) {
    id = await forkWorkspaceId(dir, id);
    console.log(`${dir} is a copy of ${original}: it now has its own history, starting from the original's`);
  }

  const previous = active;
  if (previous) {
    await flushEditSnapshot(); // don't lose the old folder's last edits
    stopWatching();
    closeHistory();
    resetBuilds();
  }
  generation++;

  active = { dir, id, name: await nameOf(dir), build: path.join(BUILD, id), roots: { latex: dir } };
  await openHistory(dir);
  await startWatching(dir, isDefault);
  await rescan();
  scheduleBrief();
  await rememberWorkspace(dir);
  claude.setInstructions((await claudeMdImportsInstructions(dir)) ? null : instructions);
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

/** Where Claude's hooks report turns; they only matter with history, which needs git. */
const hookBase = () => (Bun.which("git") ? `http://127.0.0.1:${PORT}` : null);

/**
 * Fill the open (empty) workspace from a template, then start Claude afresh so it has the template's
 * instructions. Returns the tree path of the document to open first, or throws with a reason.
 */
export function startFromTemplate(name: string): Promise<string> {
  const next = switching.then(() => fillFromTemplate(name)); // never in the middle of a switch
  switching = next.catch(() => {});
  return next;
}

async function fillFromTemplate(name: string): Promise<string> {
  const w = current();
  if (!(await isEmptyWorkspace(w.dir))) throw new Error("This folder already has .tex files. Templates only fill an empty folder.");
  const open = await applyTemplate(w.dir, name);
  await ensureClaudeSettings(w.dir, hookBase(), { insideCheckout: w.dir === (await canonical(DEFAULT_DIR)) });
  claude.setInstructions((await claudeMdImportsInstructions(w.dir)) ? null : await writeInstructions(w.dir));
  claude.renew();
  await rescan();
  broadcast(treeMessage());
  const gen = generation;
  (async () => {
    for (const doc of docs) if (gen === generation) await build(doc);
  })();
  return `latex/${open}`;
}

/** Open `dir`, or say why not (refused, or it failed partway and the old workspace stayed open). */
export async function tryOpenWorkspace(requested: string): Promise<string | null> {
  const dir = await canonical(requested);
  // From the page, only projects in the switcher: the library, and folders opened before (developer mode).
  if (!inLibrary(dir) && !(await recentWorkspaces()).includes(dir)) return "That isn't one of your projects.";
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
  const recent = await recentWorkspaces();
  const library = await listProjects();
  const dirs = [...recent, ...library.map((p) => p.dir).filter((d) => !recent.includes(d))];
  const projects = await Promise.all(dirs.map(async (dir) => ({ dir, name: await nameOf(dir) })));
  return { type: "workspace", id: w.id, dir: w.dir, name: w.name, inLibrary: inLibrary(w.dir), projects };
}

// ---------- the library ----------

/** A new project in the library, opened (empty, so it offers the templates). Returns a problem, or null. */
export async function newProject(rawName: unknown): Promise<string | null> {
  const name = cleanName(rawName);
  if (!name) return "Give the project a name.";
  return tryOpenWorkspace(await createProject(name));
}

/** Rename the open project: just its name, the folder stays where it is. */
export async function renameCurrent(rawName: unknown): Promise<string | null> {
  const name = cleanName(rawName);
  const w = current();
  if (!name) return "Give the project a name.";
  if (!inLibrary(w.dir)) return "Only projects in underleaf's library can be renamed here.";
  await renameProject(w.dir, name);
  w.name = name;
  broadcast(await workspaceMessage());
  broadcast(treeMessage());
  return null;
}

/** Copy a folder into the library as a new project and open it. The original is never touched. */
export async function importFolder(requested: string): Promise<string | null> {
  const source = await canonical(requested);
  const problem = await unusable(source);
  if (problem) return problem;
  if (inLibrary(source)) return "That's already one of your projects.";
  try {
    const dir = await copyIntoLibrary(source, cleanName(path.basename(source)) ?? "Imported");
    return tryOpenWorkspace(dir);
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Where to start without a folder on the command line: the project you had open last, else the first in
 * the library, else a new, empty one (which offers the templates).
 */
export async function libraryStart(): Promise<string> {
  const last = (await recentWorkspaces()).find(inLibrary);
  if (last) return last;
  return (await listProjects())[0]?.dir ?? (await createProject("My first document"));
}
