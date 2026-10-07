import type { DirNode, FileNode } from "../src/workspace";
import { FileTree } from "./tree";
import { ClaudeTerminal } from "./terminal";
import * as preview from "./preview";
import { $, formatBytes, storage, toast } from "./util";

type Message =
  | { type: "tree"; trees: DirNode[]; docs: string[] }
  | { type: "compiling"; doc: string }
  | {
      type: "compiled";
      doc: string;
      ok: boolean;
      engine: string;
      ms: number;
      pages: number;
      diagnostics: preview.Diagnostic[];
      pdf: string | null;
    };

const title = $("preview-title");
const exportButton = $<HTMLButtonElement>("export");
const download = $<HTMLAnchorElement>("download");
const zoomGroup = $("zoom");

let ws: WebSocket;
let selected: FileNode | null = null;
let lastPdf: string | null = null; // latest good PDF of the selected document
let firstTree = true;

const tree = new FileTree($("tree"), { onSelect: (file) => select(file) });
const claude = new ClaudeTerminal($("terminal"));

// ---------- connection ----------

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    $("connection").hidden = true;
    if (selected?.kind === "doc") send({ type: "open", doc: selected.path }); // resubscribe after a reconnect
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data) as Message);
  ws.onclose = () => {
    $("connection").hidden = false;
    setTimeout(connect, 1000);
  };
}

function handle(msg: Message) {
  if (msg.type === "tree") return onTree(msg.trees);
  if (msg.doc !== selected?.path) return;

  if (msg.type === "compiling") return preview.setStatus("compiling…", "busy");

  const errors = msg.diagnostics.filter((d) => d.severity === "error").length;
  if (msg.ok) {
    preview.setStatus(`compiled in ${msg.ms}ms · ${msg.pages} page${msg.pages === 1 ? "" : "s"} · ${msg.engine}`, "ok");
  } else {
    preview.setStatus(`${errors || 1} error${errors > 1 ? "s" : ""}${msg.pdf ? " — showing last good PDF" : ""}`, "fail");
    preview.openLogs(); // surface errors the moment they happen
  }
  preview.showDiagnostics(msg.diagnostics);

  lastPdf = msg.pdf;
  exportButton.disabled = !msg.pdf;
  download.hidden = !msg.pdf;
  if (msg.pdf) {
    download.href = `${msg.pdf}&download`;
    preview.showPdf(msg.pdf, { stale: !msg.ok });
  } else {
    preview.showMessage(`<strong>${escapeHtml(selected.name)}</strong> hasn't compiled yet — check the logs.`);
  }
}

// ---------- selection ----------

function onTree(trees: DirNode[]) {
  tree.update(trees);

  if (firstTree) {
    firstTree = false;
    const wanted = decodeURIComponent(location.hash.slice(1)) || storage("selected");
    const file = (wanted && tree.find(wanted)) || tree.firstDocument();
    if (file) select(file);
    else showNothing();
    return;
  }
  if (!selected) return;

  const now = tree.find(selected.path);
  if (!now) {
    // Deleted or renamed out from under us.
    toast(`${selected.path} was removed`);
    selected = null;
    showNothing();
  } else if (now.kind !== selected.kind || (now.kind !== "doc" && now.mtime !== selected.mtime)) {
    select(now); // changed on disk → refresh the preview (docs refresh via compile messages)
  } else {
    selected = now;
  }
}

function select(file: FileNode) {
  const switching = file.path !== selected?.path;
  selected = file;
  tree.select(file.path);
  history.replaceState(null, "", `#${encodeURIComponent(file.path)}`);
  storage("selected", file.path);
  document.title = `${file.name} · underleaf`;
  title.textContent = file.path;

  const isDoc = file.kind === "doc";
  const fileUrl = `/api/file?path=${encodeURIComponent(file.path)}&v=${file.mtime}`;
  exportButton.hidden = !isDoc;
  preview.showLogsButton(isDoc);
  zoomGroup.hidden = !(isDoc || file.kind === "pdf");
  download.hidden = isDoc; // documents get a download link once they've compiled
  download.href = `${fileUrl}&download`;

  if (isDoc) {
    if (switching) {
      lastPdf = null;
      exportButton.disabled = true;
      preview.setStatus("compiling…", "busy");
      preview.showMessage("Compiling…");
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

function showNothing() {
  title.textContent = "Preview";
  exportButton.hidden = download.hidden = zoomGroup.hidden = true;
  preview.showLogsButton(false);
  preview.setStatus("");
  preview.showMessage("Pick a file on the left, or ask Claude to create a <code>.tex</code> file in <code>latex/</code>.");
}

window.addEventListener("hashchange", () => {
  const file = tree.find(decodeURIComponent(location.hash.slice(1)));
  if (file && file.path !== selected?.path) select(file);
});

// ---------- export ----------

exportButton.onclick = async () => {
  if (!selected || !lastPdf) return;
  exportButton.disabled = true;
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc: selected.path }),
    });
    const body = (await res.json()) as { path?: string; error?: string };
    toast(body.path ? `Saved to ${body.path}` : (body.error ?? "Export failed"));
  } finally {
    exportButton.disabled = !lastPdf;
  }
};

// ---------- layout ----------

const workspace = $("workspace");

for (const splitter of document.querySelectorAll<HTMLElement>(".splitter")) {
  const pane = $(splitter.dataset.pane!);
  const cssVar = splitter.dataset.var!;
  const saved = storage(cssVar);
  if (saved) document.documentElement.style.setProperty(cssVar, saved);

  splitter.onpointerdown = (down) => {
    const startX = down.clientX;
    const startW = pane.getBoundingClientRect().width;
    splitter.setPointerCapture(down.pointerId);
    splitter.classList.add("dragging");
    workspace.classList.add("resizing");
    splitter.onpointermove = (move) => {
      const width = Math.max(160, Math.min(window.innerWidth - 360, startW + move.clientX - startX));
      document.documentElement.style.setProperty(cssVar, `${width}px`);
    };
    splitter.onpointerup = () => {
      splitter.onpointermove = splitter.onpointerup = null;
      splitter.classList.remove("dragging");
      workspace.classList.remove("resizing");
      storage(cssVar, getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim());
    };
  };
}

function panelToggle(buttonId: string, paneId: string, onShow?: () => void) {
  const button = $(buttonId);
  const pane = $(paneId);
  const splitter = pane.nextElementSibling as HTMLElement;
  const apply = (visible: boolean) => {
    pane.hidden = splitter.hidden = !visible;
    button.classList.toggle("on", visible);
    storage(paneId, visible ? "1" : "0");
    if (visible) onShow?.();
  };
  button.onclick = () => apply(pane.hidden !== false);
  apply(storage(paneId) !== "0");
}

panelToggle("toggle-tree", "tree-pane");
panelToggle("toggle-claude", "claude-pane", () => {
  claude.connect();
  claude.focus();
});

// ---------- misc ----------

function send(msg: object) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

connect();
