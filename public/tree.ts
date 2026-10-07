import type { DirNode, FileNode, TreeNode } from "../src/workspace";
import { storage } from "./util";

const ICONS = {
  folder: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>`,
  file: `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/></svg>`,
  doc: `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M5.5 8h5M5.5 10.5h5M5.5 5.5h2"/></svg>`,
};

type Handlers = { onSelect: (file: FileNode) => void };

/** Overleaf-style collapsible file tree. Folder open/closed state survives reloads. */
export class FileTree {
  private expanded = new Set<string>(JSON.parse(storage("expanded") ?? '["latex","resumes"]'));
  private trees: DirNode[] = [];
  selected: string | null = null;

  constructor(private el: HTMLElement, private handlers: Handlers) {}

  update(trees: DirNode[]) {
    this.trees = trees;
    this.render();
  }

  select(path: string | null) {
    this.selected = path;
    // Make sure the selected file is visible.
    if (path) path.split("/").slice(0, -1).forEach((_, i, parts) => this.expanded.add(parts.slice(0, i + 1).join("/")));
    this.render();
  }

  find(path: string): FileNode | undefined {
    const walk = (node: TreeNode): FileNode | undefined =>
      node.type === "file" ? (node.path === path ? node : undefined) : node.children.map(walk).find(Boolean);
    return this.trees.map(walk).find(Boolean);
  }

  firstDocument(): FileNode | undefined {
    const walk = (node: TreeNode): FileNode | undefined =>
      node.type === "file" ? (node.kind === "doc" ? node : undefined) : node.children.map(walk).find(Boolean);
    return this.trees[0] && walk(this.trees[0]);
  }

  private render() {
    const scroll = this.el.scrollTop;
    this.el.replaceChildren(...this.trees.map((t) => this.renderDir(t, 0, true)));
    this.el.scrollTop = scroll;
  }

  private renderDir(dir: DirNode, depth: number, root = false): HTMLElement {
    const open = this.expanded.has(dir.path);
    const wrap = document.createElement("div");
    const row = this.row(depth, root ? `${dir.path}/` : dir.name, root ? "" : ICONS.folder, open ? "▾" : "▸");
    if (root) row.classList.add("root");
    row.title = dir.path;
    row.onclick = () => {
      if (open) this.expanded.delete(dir.path);
      else this.expanded.add(dir.path);
      storage("expanded", JSON.stringify([...this.expanded]));
      this.render();
    };
    wrap.append(row);
    if (!open) return wrap;

    const list = document.createElement("ul");
    for (const child of dir.children) {
      const li = document.createElement("li");
      li.append(child.type === "dir" ? this.renderDir(child, depth + 1) : this.renderFile(child, depth + 1));
      list.append(li);
    }
    wrap.append(list);
    if (root && dir.children.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = dir.path === "latex" ? "Empty. Add .tex files here, or ask Claude to." : "Saved PDFs will appear here.";
      wrap.append(hint);
    }
    return wrap;
  }

  private renderFile(file: FileNode, depth: number) {
    const row = this.row(depth, file.name, file.kind === "doc" ? ICONS.doc : ICONS.file, "");
    row.classList.add(`kind-${file.kind}`);
    row.classList.toggle("selected", file.path === this.selected);
    row.title = file.kind === "doc" ? `${file.path} — LaTeX document` : file.path;
    row.onclick = () => this.handlers.onSelect(file);
    return row;
  }

  private row(depth: number, name: string, icon: string, caret: string) {
    const row = document.createElement("button");
    row.className = "row";
    row.style.setProperty("--depth", String(depth));
    row.innerHTML = `<span class="caret">${caret}</span>${icon}`;
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = name; // file names are untrusted: never innerHTML
    row.append(label);
    return row;
  }
}
