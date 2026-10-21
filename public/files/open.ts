import { FileTree } from "./tree";
import * as preview from "../preview/preview";
import { openPalette } from "../ui/palette";
import { send } from "../core/connection";
import { paletteCommands } from "../core/commands";
import { leaveSnapshot, versions } from "../history/versions";
import { closeCompare, diffView } from "../compare/compare";
import { claude, focusPane } from "../core/layout";
import { hideDocumentActions, state, ui } from "../core/state";
import { $, escapeHtml, formatBytes, STORED, storage, toast } from "../core/util";
import type { DirNode, FileNode } from "../../shared/types";
import { API, url, type ExportRequest, type ExportResponse } from "../../shared/protocol";

/** Opening files, keeping the preview in step with the file tree, and acting on files. */

export const tree = new FileTree($("tree"), { onOpen: (file) => open(file) });
let firstTree = true;

export function initOpening() {
  ui.exportButton.onclick = exportPdf;
  $("agent-toggle").onclick = () => toggleAgentFiles(!tree.agentFilesVisible);
  $("quick-open").onclick = quickOpen;
  window.addEventListener("hashchange", () => {
    const file = tree.find(decodeURIComponent(location.hash.slice(1)));
    if (file && file.path !== state.selected?.path) open(file);
  });
}

export function onTree(trees: DirNode[]) {
  tree.update(trees);
  showWorkspace();
  showAgentFoot();

  if (firstTree) {
    firstTree = false;
    const wanted = decodeURIComponent(location.hash.slice(1)) || storage(STORED.selected);
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
  storage(STORED.selected, file.path);
  state.recent = [file.path, ...state.recent.filter((p) => p !== file.path)].slice(0, 30);
  storage(STORED.recent, JSON.stringify(state.recent));
  document.title = `${file.name} · underleaf`;
  ui.title.textContent = file.path;

  const isDoc = file.kind === "doc";
  const fileUrl = url(API.file, { path: file.path, v: file.mtime });
  ui.exportButton.hidden = !isDoc;
  preview.showLogsButton(isDoc);
  ui.zoom.hidden = !(isDoc || file.kind === "pdf");
  ui.download.hidden = isDoc; // documents get a download link once they've compiled
  ui.download.href = `${fileUrl}&download`;

  if (isDoc) {
    if (switching) {
      state.lastPdf = null;
      ui.exportButton.disabled = true;
      preview.setStatus("Building…", "busy");
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
    if (file.kind === "tex") preview.setStatus("Part of another document", "info", "No \\documentclass: this file is included by another one, so it's shown as source.");
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

/** The title bar names the folder you're working in ("~/Documents/thesis"). */
function showWorkspace() {
  const dir = state.roots.latex;
  if (!dir) return;
  $("workspace-name").textContent = dir.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

/** "2 agent files hidden · Show": CLAUDE.md and memory/ stay out of the way but easy to find. */
function showAgentFoot() {
  const n = tree.agentFileCount;
  $("tree-foot").hidden = n === 0;
  $("agent-count").textContent = tree.agentFilesVisible ? `Agent files shown` : `${n} agent file${n === 1 ? "" : "s"} hidden`;
  $("agent-toggle").textContent = tree.agentFilesVisible ? "Hide" : "Show";
}

export function toggleAgentFiles(visible: boolean) {
  tree.setAgentFilesVisible(visible);
  showAgentFoot();
  toast(visible ? "Agent files shown: CLAUDE.md and memory/" : "Agent files hidden");
  if (visible) focusPane("tree");
}

// ---------- acting on files ----------

export async function exportPdf() {
  const selected = state.selected;
  if (!selected || selected.kind !== "doc" || !state.lastPdf) return toast("Open a document that compiles to save its PDF");
  ui.exportButton.disabled = true;
  try {
    const request: ExportRequest = { doc: selected.path };
    const res = await fetch(API.export, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = (await res.json().catch(() => ({ error: "Export failed" }))) as ExportResponse;
    toast("path" in body ? `Saved to ${body.path}` : body.error);
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
  // Files first (most recent on top), then commands, so one search box reaches both.
  openPalette({
    placeholder: "Go to file or command…",
    emptyText: "No matching files or commands",
    items: [...files.map((f) => ({ label: f.path, run: () => open(f) })), ...paletteCommands()],
  });
}
