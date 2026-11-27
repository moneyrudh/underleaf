import path from "node:path";
import { cp, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { PROJECTS } from "../home";

/**
 * The library: every project is a folder in the app's data folder (PROJECTS), named by a stable id
 * made from its first name ("thesis", "resume-2"). The name you see is kept in .underleaf/name, so
 * renaming never moves the folder (which would cost Claude its conversation, kept per folder path).
 * Nobody has to know where it is; Show files in Finder opens it.
 */

export type Project = { dir: string; name: string };

const NAME_FILE = [".underleaf", "name"];
/** Never copied when importing: another tool's data, or underleaf's own from wherever it came from. */
const SKIP_ON_IMPORT = new Set([".git", ".underleaf", "node_modules", ".DS_Store", ".Trash"]);
const MAX_IMPORT_FILES = 5000;
const MAX_IMPORT_BYTES = 1024 ** 3;

export const inLibrary = (dir: string) => dir.startsWith(PROJECTS + path.sep);

/** A project's name: what it was called or renamed to, else its folder's name. */
export async function nameOf(dir: string): Promise<string> {
  const saved = (await Bun.file(path.join(dir, ...NAME_FILE)).text().catch(() => "")).trim();
  return saved || path.basename(dir);
}

/** Every project in the library, by name. */
export async function listProjects(): Promise<Project[]> {
  await mkdir(PROJECTS, { recursive: true });
  const out: Project[] = [];
  for (const entry of await readdir(PROJECTS, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(PROJECTS, entry.name);
    out.push({ dir, name: await nameOf(dir) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A name someone typed, tidied; null if there's nothing usable left. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return name || null;
}

/** A new, empty project folder in the library, named `name`. */
export async function createProject(name: string): Promise<string> {
  const dir = await freeFolder(name);
  await mkdir(path.join(dir, ".underleaf"), { recursive: true });
  await Bun.write(path.join(dir, ...NAME_FILE), name + "\n");
  return dir;
}

export async function renameProject(dir: string, name: string) {
  await Bun.write(path.join(dir, ...NAME_FILE), name + "\n");
}

/** Copy a folder from anywhere into the library as a new project (with its own history). The original is never touched. */
export async function copyIntoLibrary(source: string, name: string): Promise<string> {
  const real = await realpath(source);
  const { files, bytes } = await sizeOf(real);
  if (files > MAX_IMPORT_FILES || bytes > MAX_IMPORT_BYTES) {
    throw new Error(`That folder is too big to import (${files} files, ${Math.round(bytes / 1024 ** 2)} MB). Pick the folder of one document.`);
  }
  const dir = await freeFolder(name);
  await cp(real, dir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return !SKIP_ON_IMPORT.has(base) && !base.endsWith(".underleaf-save");
    },
  });
  await mkdir(path.join(dir, ".underleaf"), { recursive: true });
  await Bun.write(path.join(dir, ...NAME_FILE), name + "\n");
  return dir;
}

/** A folder name for `name` that isn't taken: "My Thesis" → "my-thesis", then "my-thesis-2". */
async function freeFolder(name: string): Promise<string> {
  await mkdir(PROJECTS, { recursive: true });
  const base = name.toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  for (let n = 1; ; n++) {
    const dir = path.join(PROJECTS, n === 1 ? base : `${base}-${n}`);
    if (!(await stat(dir).catch(() => null))) return dir;
  }
}

async function sizeOf(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (SKIP_ON_IMPORT.has(entry.name)) continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) {
        files++;
        bytes += (await stat(p).catch(() => null))?.size ?? 0;
      }
      if (files > MAX_IMPORT_FILES) return;
    }
  };
  await walk(dir);
  return { files, bytes };
}

/** Open a project's folder in the system's file manager. */
export function reveal(dir: string) {
  const cmd = process.platform === "darwin" ? ["open", dir] : process.platform === "win32" ? ["explorer", dir] : ["xdg-open", dir];
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
}
