import type { DirNode, FileNode } from "../src/workspace";
import { FileTree } from "./tree";
import * as preview from "./preview";
import { openPalette } from "./palette";
import { send } from "./connection";
import { leaveSnapshot, versions } from "./versions";
import { closeCompare, diffView } from "./compare";
import { claude, focusPane } from "./layout";
import { hideDocumentActions, state, ui } from "./state";
import { $, escapeHtml, formatBytes, storage, toast } from "./util";

/** Opening files, keeping the preview in step with the file tree, and acting on files. */

export const tree = new FileTree($("tree"), { onOpen: (file) => open(file) });
let firstTree = true;

export function initOpening() {
  ui.exportButton.onclick = exportPdf;
  $("quick-open").onclick = quickOpen;
  window.addEventListener("hashchange", () => {
    const file = tree.find(decodeURIComponent(location.hash.slice(1)));
    if (file && file.path !== state.selected?.path) open(file);
  });
}

export function onTree(trees: DirNode[]) {
  tree.update(trees);

  if (firstTree) {
    firstTree = false;
    const wanted = decodeURIComponent(location.hash.slice(1)) || storage("selected");
    const file = (wanted && tree.find(wanted)) || tree.firstDocument();
    if (file) open(file);
    else showNothing();
    return;
  }
  const selected = state.selected;
  if (!selected) return;

  const now = tree.find(selected.path);
  if (!now) {
    // Deleted or renamed out from under us.
    toast(`${selected.path} was removed`);
    state.selected = null;
    tree.setOpened(null);
    showNothing();
  } else if (diffView.active) {
    if (now.mtime !== selected.mtime) diffView.liveFile(now.path);
    state.selected = now;
  } else if (versions.viewing) {
    state.selected = now; // looking at an earlier version: the live file refreshes when you go back
  } else if (now.kind !== selected.kind || (now.kind !== "doc" && now.mtime !== selected.mtime)) {
    open(now); // changed on disk → refresh the preview (docs refresh via compile messages)
  } else {
    state.selected = now;
  }
}

export function open(file: FileNode) {
  const switching = file.path !== state.selected?.path;
  const leavingSnapshot = !!versions.viewing || diffView.active;
  closeCompare();
  leaveSnapshot();
  // Keep what's on screen (dimmed) until the next view is ready, instead of blanking it.
  if ((switching || leavingSnapshot) && preview.hasContent()) preview.beginLoading({ keepScroll: !switching });
  state.selected = file;
  versions.setFile(file.path, state.historyEnabled);
  tree.setOpened(file.path);
  history.replaceState(null, "", `#${encodeURIComponent(file.path)}`);
  storage("selected", file.path);
  state.recent = [file.path, ...state.recent.filter((p) => p !== file.path)].slice(0, 30);
  storage("recent", JSON.stringify(state.recent));
  document.title = `${file.name} · underleaf`;
  ui.title.textContent = file.path;

  const isDoc = file.kind === "doc";
  const fileUrl = `/api/file?path=${encodeURIComponent(file.path)}&v=${file.mtime}`;
  ui.exportButton.hidden = !isDoc;
  preview.showLogsButton(isDoc);
  ui.zoom.hidden = !(isDoc || file.kind === "pdf");
  ui.download.hidden = isDoc; // documents get a download link once they've compiled
  ui.download.href = `${fileUrl}&download`;

  if (isDoc) {
    if (switching) {
      state.lastPdf = null;
      ui.exportButton.disabled = true;
      preview.setStatus("compiling…", "busy");
      if (!preview.hasContent()) preview.showMessage("Compiling…"); // nothing to keep on screen meanwhile
    }
    send({ type: "open", doc: file.path });
    return;
  }

  send({ type: "close" });
  preview.setStatus(formatBytes(file.size), "info");
  if (file.kind === "pdf") preview.showPdf(fileUrl);
  else if (file.kind === "image") preview.showImage(fileUrl);
  else if (file.kind === "tex" || file.kind === "text") {
    preview.showText(fileUrl);
    if (file.kind === "tex") preview.setStatus("no \\documentclass — included by another file, shown as source", "info");
  } else {
    preview.showMessage(`No preview for <strong>${escapeHtml(file.name)}</strong>.<br>Use ⤓ to download it.`);
  }
}

/** Re-open the open file: back to its current version, leaving any comparison or earlier version. */
export function reopen() {
  if (state.selected) open(state.selected);
}

export function showNothing() {
  closeCompare();
  leaveSnapshot();
  versions.setFile(null, state.historyEnabled);
  ui.title.textContent = "Preview";
  hideDocumentActions();
  preview.showLogsButton(false);
  preview.setStatus("");
  preview.showMessage("Pick a file on the left, or ask Claude to create a <code>.tex</code> file in <code>latex/</code>.");
}

// ---------- acting on files ----------

export async function exportPdf() {
  const selected = state.selected;
  if (!selected || selected.kind !== "doc" || !state.lastPdf) return toast("Open a document that compiles to save its PDF");
  ui.exportButton.disabled = true;
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc: selected.path }),
    });
    const body = (await res.json()) as { path?: string; error?: string };
    toast(body.path ? `Saved to ${body.path}` : (body.error ?? "Export failed"));
  } finally {
    ui.exportButton.disabled = !state.lastPdf;
  }
}

/** Claude runs in latex/, so mention files relative to it (absolute for anything elsewhere). */
export function mention(file: FileNode | null | undefined) {
  if (!file) return;
  const [rootKey, ...rest] = file.path.split("/");
  const rel = rootKey === "latex" ? rest.join("/") : `${state.roots[rootKey!] ?? rootKey}/${rest.join("/")}`;
  focusPane("claude");
  claude.paste(`@${rel.includes(" ") ? `"${rel}"` : rel} `);
}

export async function copyPath(file: FileNode | null | undefined) {
  if (!file) return;
  try {
    await navigator.clipboard.writeText(file.path);
    toast(`Copied ${file.path}`);
  } catch {
    toast("Couldn't access the clipboard");
  }
}

export function quickOpen() {
  const rank = (p: string) => {
    const i = state.recent.indexOf(p);
    return i < 0 ? Infinity : i;
  };
  const files = tree.files().sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
  openPalette({
    placeholder: "Go to file…",
    emptyText: "No matching files",
    items: files.map((f) => ({ label: f.path, run: () => open(f) })),
  });
}
