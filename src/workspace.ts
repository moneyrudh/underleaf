import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";

/** doc = a .tex with \documentclass (compilable); tex = an \input'd fragment. */
export type Kind = "doc" | "tex" | "pdf" | "image" | "text" | "other";
export type FileNode = { type: "file"; name: string; path: string; kind: Kind; size: number; mtime: number };
export type DirNode = { type: "dir"; name: string; path: string; children: TreeNode[] };
export type TreeNode = FileNode | DirNode;

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
const TEXT = new Set([".cls", ".sty", ".bib", ".bst", ".txt", ".md", ".json", ".yaml", ".yml", ".csv", ".cfg", ".def", ".log"]);

export const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export async function kindOf(file: string): Promise<Kind> {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".tex") return isDocument(file).then((doc) => (doc ? "doc" : "tex"));
  if (ext === ".pdf") return "pdf";
  if (IMAGE.has(ext)) return "image";
  if (TEXT.has(ext)) return "text";
  return "other";
}

async function isDocument(file: string) {
  const src = await Bun.file(file).text().catch(() => "");
  return /^[^%\n]*\\documentclass/m.test(src);
}

/** Snapshot of a directory for the sidebar. Hidden files and symlinks are skipped. */
export async function scanTree(dir: string, treePath: string, name = path.basename(dir)): Promise<DirNode> {
  const node: DirNode = { type: "dir", name, path: treePath, children: [] };
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const abs = path.join(dir, entry.name);
    const rel = `${treePath}/${entry.name}`;
    if (entry.isDirectory()) {
      node.children.push(await scanTree(abs, rel));
    } else if (entry.isFile()) {
      const info = await stat(abs).catch(() => null);
      if (info) node.children.push({ type: "file", name: entry.name, path: rel, kind: await kindOf(abs), size: info.size, mtime: info.mtimeMs });
    }
  }
  node.children.sort((a, b) =>
    a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  return node;
}

/** Flat list of compilable documents, relative to the tree root. */
export function documentsIn(tree: DirNode): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode) => {
    if (node.type === "dir") node.children.forEach(walk);
    else if (node.kind === "doc") out.push(node.path.slice(tree.path.length + 1));
  };
  walk(tree);
  return out;
}

/**
 * Map a sidebar path ("latex/a/b.tex") back to disk, refusing anything that escapes
 * its root — including through symlinks.
 */
export async function resolveTreePath(roots: Record<string, string>, treePath: string): Promise<string | null> {
  const [key, ...rest] = treePath.split("/");
  const root = key ? roots[key] : undefined;
  if (!root) return null;
  const abs = path.resolve(root, ...rest);
  const real = await realpath(abs).catch(() => null);
  const realRoot = await realpath(root).catch(() => null);
  if (!real || !realRoot) return null;
  return real === realRoot || real.startsWith(realRoot + path.sep) ? abs : null;
}

/**
 * Watch a directory recursively and keep it alive: if it's deleted or replaced
 * (fs.watch goes silent when that happens), recreate it and start watching again.
 */
export function keepWatching(dir: string, onChange: (filename: string) => void) {
  let watcher: FSWatcher | undefined;
  let inode: number | undefined;

  const start = async () => {
    await mkdir(dir, { recursive: true });
    inode = (await stat(dir)).ino;
    watcher?.close();
    watcher = watch(dir, { recursive: true }, (_event, filename) => onChange(filename ?? ""));
    watcher.on("error", () => {}); // the health check below takes over
  };

  setInterval(async () => {
    const info = await stat(dir).catch(() => null);
    if (info?.isDirectory() && info.ino === inode) return;
    await start();
    onChange("");
  }, 1000);

  return start();
}
