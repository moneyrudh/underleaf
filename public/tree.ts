import type { DirNode, FileNode, TreeNode } from "../src/workspace";
import { storage } from "./util";

const ICONS = {
  folder: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>`,
  file: `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/></svg>`,
  doc: `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M5.5 8h5M5.5 10.5h5M5.5 5.5h2"/></svg>`,
};
const FLASH_MS = 1600;

type Handlers = { onOpen: (file: FileNode) => void };

/**
 * Overleaf-style collapsible file tree with a vim-style keyboard cursor.
 * The cursor (where you are) is separate from the open file (what's previewed).
 */
export class FileTree {
  private expanded = new Set<string>(JSON.parse(storage("expanded") ?? '["latex","resumes"]'));
  private trees: DirNode[] = [];
  private nodes = new Map<string, TreeNode>();
  private visible: string[] = []; // row paths in display order, for j/k
  private mtimes = new Map<string, number>();
  private changedAt = new Map<string, number>();
  opened: string | null = null;
  cursor: string | null = null;

  constructor(private el: HTMLElement, private handlers: Handlers) {}

  update(trees: DirNode[]) {
    const firstLoad = this.trees.length === 0;
    this.trees = trees;
    this.nodes.clear();
    const index = (node: TreeNode) => {
      this.nodes.set(node.path, node);
      if (node.type === "dir") node.children.forEach(index);
      else {
        // Flash files that changed on disk (e.g. Claude just edited them).
        const before = this.mtimes.get(node.path);
        if (!firstLoad && before !== node.mtime) this.changedAt.set(node.path, performance.now());
        this.mtimes.set(node.path, node.mtime);
      }
    };
    trees.forEach(index);
    if (this.cursor && !this.nodes.has(this.cursor)) this.cursor = null;
    this.render();
  }

  find(path: string): FileNode | undefined {
    const node = this.nodes.get(path);
    return node?.type === "file" ? node : undefined;
  }

  files(): FileNode[] {
    return [...this.nodes.values()].filter((n): n is FileNode => n.type === "file");
  }

  firstDocument(): FileNode | undefined {
    return this.files().find((f) => f.kind === "doc" && f.path.startsWith("latex/"));
  }

  /** Mark a file as open, reveal it, and put the cursor on it. */
  setOpened(path: string | null) {
    this.opened = path;
    if (path) {
      this.reveal(path);
      this.cursor = path;
    }
    this.render();
    this.scrollToCursor();
  }

  // ---------- keyboard ----------

  move(delta: number) {
    if (this.visible.length === 0) return;
    const at = this.cursor ? this.visible.indexOf(this.cursor) : -1;
    const next = at < 0 ? 0 : Math.max(0, Math.min(this.visible.length - 1, at + delta));
    this.setCursor(this.visible[next]!);
  }

  edge(which: "first" | "last") {
    const path = which === "first" ? this.visible[0] : this.visible[this.visible.length - 1];
    if (path) this.setCursor(path);
  }

  /** h: collapse the folder under the cursor, or step out to its parent. */
  left() {
    const node = this.cursor ? this.nodes.get(this.cursor) : undefined;
    if (!node) return this.move(0);
    if (node.type === "dir" && this.expanded.has(node.path)) return this.toggle(node.path, false);
    const parent = node.path.split("/").slice(0, -1).join("/");
    if (this.nodes.has(parent)) this.setCursor(parent);
  }

  /** l: expand a folder (or step into it), or open a file. */
  right() {
    const node = this.cursor ? this.nodes.get(this.cursor) : undefined;
    if (!node) return this.move(0);
    if (node.type === "file") return this.handlers.onOpen(node);
    if (!this.expanded.has(node.path)) return this.toggle(node.path, true);
    const first = node.children[0];
    if (first) this.setCursor(first.path);
  }

  /** Enter / o: open a file, or toggle a folder. */
  activate() {
    const node = this.cursor ? this.nodes.get(this.cursor) : undefined;
    if (!node) return this.move(0);
    if (node.type === "file") this.handlers.onOpen(node);
    else this.toggle(node.path, !this.expanded.has(node.path));
  }

  cursorFile(): FileNode | undefined {
    return this.cursor ? this.find(this.cursor) : undefined;
  }

  private setCursor(path: string) {
    this.cursor = path;
    this.render();
    this.scrollToCursor();
  }

  private toggle(path: string, open: boolean) {
    if (open) this.expanded.add(path);
    else this.expanded.delete(path);
    storage("expanded", JSON.stringify([...this.expanded]));
    this.render();
  }

  private reveal(path: string) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join("/"));
  }

  private scrollToCursor() {
    this.el.querySelector(".row.cursor")?.scrollIntoView({ block: "nearest" });
  }

  // ---------- rendering ----------

  private render() {
    const scroll = this.el.scrollTop;
    this.visible = [];
    this.el.replaceChildren(...this.trees.map((t) => this.renderDir(t, 0, true)));
    this.el.scrollTop = scroll;
  }

  private renderDir(dir: DirNode, depth: number, root = false): HTMLElement {
    const open = this.expanded.has(dir.path);
    const wrap = document.createElement("div");
    wrap.setAttribute("role", "group");
    const row = this.row(dir.path, depth, root ? `${dir.path}/` : dir.name, root ? "" : ICONS.folder, open ? "▾" : "▸");
    if (root) row.classList.add("root");
    row.setAttribute("aria-expanded", String(open));
    row.onclick = () => {
      this.cursor = dir.path;
      this.toggle(dir.path, !open);
    };
    wrap.append(row);
    if (!open) return wrap;

    for (const child of dir.children) {
      wrap.append(child.type === "dir" ? this.renderDir(child, depth + 1) : this.renderFile(child, depth + 1));
    }
    if (root && dir.children.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = dir.path === "latex" ? "Empty. Add .tex files here, or ask Claude to." : "Saved PDFs will appear here.";
      wrap.append(hint);
    }
    return wrap;
  }

  private renderFile(file: FileNode, depth: number) {
    const row = this.row(file.path, depth, file.name, file.kind === "doc" ? ICONS.doc : ICONS.file, "");
    row.classList.add(`kind-${file.kind}`);
    row.classList.toggle("opened", file.path === this.opened);
    row.title = file.kind === "doc" ? `${file.path} — LaTeX document` : file.path;
    const changed = this.changedAt.get(file.path);
    if (changed !== undefined) {
      const elapsed = performance.now() - changed;
      if (elapsed < FLASH_MS) {
        row.classList.add("changed");
        row.style.animationDelay = `-${elapsed}ms`; // re-renders continue the animation rather than restart it
      } else this.changedAt.delete(file.path);
    }
    row.onclick = () => {
      this.cursor = file.path;
      this.handlers.onOpen(file);
    };
    return row;
  }

  private row(path: string, depth: number, name: string, icon: string, caret: string) {
    this.visible.push(path);
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role", "treeitem");
    row.classList.toggle("cursor", path === this.cursor);
    row.style.setProperty("--depth", String(depth));
    row.innerHTML = `<span class="caret">${caret}</span>${icon}`;
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = name; // file names are untrusted: never innerHTML
    row.append(label);
    return row;
  }
}
