import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { HOME } from "../home";

/** Folders you've opened in underleaf, most recent first, in ~/.underleaf/workspaces.json. */

type Entry = { dir: string; openedAt: number };
const FILE = path.join(HOME, "workspaces.json");
const KEEP = 20;

async function read(): Promise<Entry[]> {
  const raw = await Bun.file(FILE).json().catch(() => null);
  return Array.isArray(raw?.recent) ? raw.recent.filter((e: Entry) => typeof e?.dir === "string") : [];
}

/** Recently opened folders that still exist, most recent first. */
export async function recentWorkspaces(): Promise<string[]> {
  const out: string[] = [];
  for (const e of await read()) {
    if ((await stat(e.dir).catch(() => null))?.isDirectory()) out.push(e.dir);
  }
  return out;
}

/**
 * Another folder you've opened that still exists and has the same workspace id: `dir` is a copy of
 * it (Finder Duplicate, cp -R). A folder that was moved leaves no such folder behind.
 */
export async function copiedFrom(dir: string, id: string): Promise<string | null> {
  for (const e of await read()) {
    const other = await realpath(e.dir).catch(() => null);
    if (!other || other === dir) continue;
    const otherId = (await Bun.file(path.join(other, ".underleaf", "id")).text().catch(() => "")).trim();
    if (otherId === id) return other;
  }
  return null;
}

export async function rememberWorkspace(dir: string) {
  const recent = [{ dir, openedAt: Date.now() }, ...(await read()).filter((e) => e.dir !== dir)].slice(0, KEEP);
  await Bun.write(FILE, JSON.stringify({ recent }, null, 2) + "\n");
}
