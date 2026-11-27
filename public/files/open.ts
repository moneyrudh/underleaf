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
import { API, url } from "../../shared/protocol";
import { loadSaveTarget, savePdf } from "./save";
import { showTemplates } from "./templates";
import { editor } from "../editor/editor";

/** Opening files, keeping the preview in step with the file tree, and acting on files. */

export const tree = new FileTree($("tree"), { onOpen: (file) => open(file) });
let firstTree = true;

export function initOpening() {
  ui.exportButton.onclick = savePdf;
  $("agent-toggle").onclick = () => toggleAgentFiles(!tree.agentFilesVisible);
  $("quick-open").onclick = quickOpen;
  $("tab-claude").onclick = () => showMiddle("claude", true);
  $("tab-source").onclick = () => showMiddle("source", true);
  showMiddle(storage(STORED.middle) === "source" ? "source" : "claude");

  window.addEventListener("hashchange", () => {
    const file = tree.find(decodeURIComponent(location.hash.slice(1)));
    if (file && file.path !== state.selected?.path) open(file);
  });
}

export function onTree(trees: DirNode[]) {
  tree.update(trees);
  showAgentFoot();

  if (firstTree) {
    firstTree = false;
    // The address (a link or a reload), else this workspace's last open file, else its first document.
    // The address can name a file from another workspace after a switch, so each is tried in turn.
    const fromHash = decodeURIComponent(location.hash.slice(1));
    const file = (fromHash && tree.find(fromHash)) || tree.find(storage(STORED.selected) ?? "") || tree.firstDocument();
    if (file) open(file);
    else showNothing();
    return;
  }
  const selected = state.selected;
  if (!selected) return;

  const now = tree.find(selected.path);
  // The editor reconciles its own file: our saves are ignored, Claude's are taken or asked about.
  if (now && editor.path === now.path && now.mtime !== selected.mtime) void editor.changedOnDisk(now);
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
  } else if (now.kind !== selected.kind || (now.kind !== "doc" && now.mtime !== selected.mtime && editor.path !== now.path)) {
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
  ui.title.textContent = displayPath(file.path);
  ui.title.dataset.path = file.path;
  showEditor(file);

  const isDoc = file.kind === "doc";
  const fileUrl = url(API.file, { path: file.path, v: file.mtime });
  ui.save.hidden = !isDoc;
  preview.showLogsButton(isDoc);
  ui.zoom.hidden = !(isDoc || file.kind === "pdf");
  ui.download.hidden = isDoc; // documents save through the Save menu instead
  ui.download.href = `${fileUrl}&download`;

  if (isDoc) {
    if (switching) loadSaveTarget();
    if (switching) {
      state.lastPdf = null;
      state.build = "running";
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
    // Text files open in the editor (it fills the pane); the viewer only shows them for earlier versions.
    if (file.kind === "tex") preview.setStatus("Part of another document", "info", "No \\documentclass: another file includes this one. Saving it rebuilds the documents that are open.");
  } else {
    preview.showMessage(`No preview for <strong>${escapeHtml(file.name)}</strong>.<br>Download it from the ⋯ menu.`);
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
  delete ui.title.dataset.path;
  hideDocumentActions();
  preview.showLogsButton(false);
  preview.setStatus("");
  showEditor(null);
  if (!tree.hasTex()) return void showTemplates();
  preview.showMessage("Pick a file on the left, or ask Claude to create a <code>.tex</code> file here.");
}

// ---------- editing: on the page, in Source (middle column), or a plain text editor ----------

/**
 * A document shows its PDF, whose text can be edited on the page (preview/pageedit.ts), and its
 * LaTeX in the middle column's Source tab. Other text files (\input chapters, .bib, notes) open in
 * the editor, which fills the preview. While an earlier version or a comparison is on screen, the
 * editor steps aside on its own (CSS).
 */
function showEditor(file: FileNode | null) {
  const body = $("preview-body");
  const full = file?.kind === "tex" || file?.kind === "text";
  if (full) body.dataset.editor = "full";
  else delete body.dataset.editor;
  $("claude-pane").toggleAttribute("data-has-source", file?.kind === "doc");
  if (file && (file.kind === "doc" || full)) void editor.open(file);
  else void editor.close();
}

/** The middle column: Claude's terminal, or the open document's LaTeX. */
export function showMiddle(which: "claude" | "source", focus = false) {
  storage(STORED.middle, which);
  const pane = $("claude-pane");
  pane.dataset.mid = which;
  $("tab-claude").classList.toggle("on", which === "claude");
  $("tab-source").classList.toggle("on", which === "source");
  $("tab-claude").setAttribute("aria-selected", String(which === "claude"));
  $("tab-source").setAttribute("aria-selected", String(which === "source"));
  if (!focus) return;
  if (which === "claude") focusPane("claude");
  else setTimeout(() => editor.focus(), 50);
}

/** e: switch the middle column between Claude and Source. */
export function toggleMiddle() {
  showMiddle($("claude-pane").dataset.mid === "source" ? "claude" : "source", true);
}

/** "2 of Claude's files hidden · Show": CLAUDE.md and memory/ stay out of the way but easy to find. */
function showAgentFoot() {
  const n = tree.agentFileCount;
  $("tree-foot").hidden = n === 0;
  $("agent-count").textContent = tree.agentFilesVisible ? `Claude's files shown` : `${n} of Claude's files hidden`;
  $("agent-toggle").textContent = tree.agentFilesVisible ? "Hide" : "Show";
}

export function toggleAgentFiles(visible: boolean) {
  tree.setAgentFilesVisible(visible);
  showAgentFoot();
  toast(visible ? "Claude's files shown: CLAUDE.md and memory/" : "Claude's files hidden");
  if (visible) focusPane("tree");
}

/** A file as people see it: its path inside the workspace, without the internal "latex/" root key. */
export const displayPath = (treePath: string) => treePath.replace(/^latex\//, "");

// ---------- acting on files ----------

/** Claude runs in latex/, so mention files relative to it (absolute for anything elsewhere). */
export function mention(file: FileNode | null | undefined) {
  if (!file) return;
  const [rootKey, ...rest] = file.path.split("/");
  const rel = rootKey === "latex" ? rest.join("/") : `${state.roots[rootKey!] ?? rootKey}/${rest.join("/")}`;
  showMiddle("claude");
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
