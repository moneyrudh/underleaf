import type { DirNode, FileNode } from "../src/workspace";
import type { Snapshot } from "../src/history";
import { HistoryPanel, KIND_ICONS, relativeTime } from "./history";
import { DiffView, type Side } from "./diff";
import { FileTree } from "./tree";
import { ClaudeTerminal, type ClaudeStart } from "./terminal";
import * as preview from "./preview";
import { closePalette, openPalette, paletteOpen } from "./palette";
import { installKeymap, label, LEADER, type Bindings } from "./keys";
import { $, formatBytes, storage, toast } from "./util";
import { installHints } from "./hints";

type Message =
  | { type: "tree"; trees: DirNode[]; docs: string[]; roots: Record<string, string>; history: boolean }
  | { type: "history" }
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
const cheatsheet = $("cheatsheet");

let ws: WebSocket;
let selected: FileNode | null = null;
let historyEnabled = false;
let snapshotPdfUrl: string | null = null; // object URL of the earlier version being viewed
let lastPdf: string | null = null; // latest good PDF of the selected document
let roots: Record<string, string> = {};
let firstTree = true;
let recent: string[] = JSON.parse(storage("recent") ?? "[]");

const tree = new FileTree($("tree"), { onOpen: (file) => open(file) });
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
  if (msg.type === "tree") {
    roots = msg.roots;
    historyEnabled = msg.history;
    onTree(msg.trees);
    versions.setFile(selected?.path ?? null, historyEnabled);
    return;
  }
  if (msg.type === "history") return void versions.refresh();
  if (!selected || msg.doc !== selected.path) return;

  // Comparing: a live side follows the build, and nothing else on screen changes.
  if (diffView.active) {
    if (msg.type === "compiled") {
      lastPdf = msg.pdf;
      diffView.livePdf(msg.doc, msg.pdf);
    }
    return;
  }

  // While an earlier version is on screen, keep tracking the live build but don't replace the view.
  if (msg.type === "compiling") return versions.viewing ? undefined : preview.setStatus("compiling…", "busy");
  if (versions.viewing) {
    lastPdf = msg.pdf;
    return;
  }

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

// ---------- opening files ----------

function onTree(trees: DirNode[]) {
  tree.update(trees);

  if (firstTree) {
    firstTree = false;
    const wanted = decodeURIComponent(location.hash.slice(1)) || storage("selected");
    const file = (wanted && tree.find(wanted)) || tree.firstDocument();
    if (file) open(file);
    else showNothing();
    return;
  }
  if (!selected) return;

  const now = tree.find(selected.path);
  if (!now) {
    // Deleted or renamed out from under us.
    toast(`${selected.path} was removed`);
    selected = null;
    tree.setOpened(null);
    showNothing();
  } else if (diffView.active) {
    if (now.mtime !== selected.mtime) diffView.liveFile(now.path);
    selected = now;
  } else if (versions.viewing) {
    selected = now; // looking at an earlier version: the live file refreshes when you go back
  } else if (now.kind !== selected.kind || (now.kind !== "doc" && now.mtime !== selected.mtime)) {
    open(now); // changed on disk → refresh the preview (docs refresh via compile messages)
  } else {
    selected = now;
  }
}

function open(file: FileNode) {
  const switching = file.path !== selected?.path;
  const leavingSnapshot = !!versions.viewing || diffView.active;
  closeCompare();
  leaveSnapshot();
  // Keep what's on screen (dimmed) until the next view is ready, instead of blanking it.
  if ((switching || leavingSnapshot) && preview.hasContent()) preview.beginLoading({ keepScroll: !switching });
  selected = file;
  versions.setFile(file.path, historyEnabled);
  tree.setOpened(file.path);
  history.replaceState(null, "", `#${encodeURIComponent(file.path)}`);
  storage("selected", file.path);
  recent = [file.path, ...recent.filter((p) => p !== file.path)].slice(0, 30);
  storage("recent", JSON.stringify(recent));
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

function showNothing() {
  closeCompare();
  leaveSnapshot();
  versions.setFile(null, historyEnabled);
  title.textContent = "Preview";
  exportButton.hidden = download.hidden = zoomGroup.hidden = true;
  preview.showLogsButton(false);
  preview.setStatus("");
  preview.showMessage("Pick a file on the left, or ask Claude to create a <code>.tex</code> file in <code>latex/</code>.");
}

window.addEventListener("hashchange", () => {
  const file = tree.find(decodeURIComponent(location.hash.slice(1)));
  if (file && file.path !== selected?.path) open(file);
});

// ---------- version history ----------

const versions = new HistoryPanel({
  // While comparing versions, the strip (and , / .) moves the "before" side.
  onView: (snap) => (comparing ? compareVersions(snap, comparing.b) : viewSnapshot(snap)),
  onCurrent: () => (comparing?.b ? compareVersions(null, comparing.b) : selected && open(selected)),
  onCompare: (snap) => compareVersions(snap, null),
  onRestore: (snap) => restoreSnapshot(snap),
});

function leaveSnapshot() {
  if (versions.viewing) versions.showViewing(null);
  if (snapshotPdfUrl) URL.revokeObjectURL(snapshotPdfUrl);
  snapshotPdfUrl = null;
}

async function viewSnapshot(snap: Snapshot) {
  if (!selected || !snap.path) return;
  closeCompare();
  versions.showViewing(snap);
  if (preview.hasContent()) preview.beginLoading({ keepScroll: true }); // same file: keep your place
  exportButton.hidden = download.hidden = true;
  const where = `${snap.label} · ${relativeTime(snap.time)}`;
  const query = `commit=${snap.id}&path=${encodeURIComponent(snap.path)}`;

  if (selected.kind === "doc" && snap.path.endsWith(".tex")) {
    preview.setStatus("compiling this version…", "busy");
    const res = await fetch(`/api/history/pdf?${query}`).catch(() => null);
    if (versions.viewing?.id !== snap.id) return; // moved on while it compiled
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { diagnostics?: preview.Diagnostic[] } | null;
      preview.showDiagnostics(body?.diagnostics ?? []);
      preview.showMessage("This version doesn't compile. Its errors are in <strong>Logs</strong>.");
      preview.setStatus(where, "fail");
      return;
    }
    if (snapshotPdfUrl) URL.revokeObjectURL(snapshotPdfUrl);
    snapshotPdfUrl = URL.createObjectURL(await res.blob());
    preview.showPdf(snapshotPdfUrl);
  } else if (selected.kind === "pdf") {
    preview.showPdf(`/api/history/file?${query}`);
  } else if (selected.kind === "image") {
    preview.showImage(`/api/history/file?${query}`);
  } else {
    preview.showText(`/api/history/file?${query}`);
  }
  preview.setStatus(where, "info");
}

async function restoreSnapshot(snap: Snapshot) {
  if (!selected) return;
  const res = await fetch("/api/history/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commit: snap.id, path: snap.path, target: selected.path }),
  }).catch(() => null);
  if (!res?.ok) return toast("Couldn't restore that version");
  const { changed } = (await res.json()) as { changed: boolean };
  toast(
    !changed
      ? `${selected.name} already matches this version. Nothing to restore.`
      : snap.kind === "export"
        ? `Restored ${selected.name} to the exported version. The version you replaced is saved in history.`
        : `Restored ${selected.name}. The version you replaced is saved in history.`,
  );
  open(selected);
}

// ---------- comparing ----------

const diffView = new DiffView({
  onPick: (which, value) => {
    if (!comparing) return;
    const snap = value === "now" ? null : (versions.all.find((s) => s.id === value) ?? null);
    compareVersions(which === "a" ? snap : comparing.a, which === "b" ? snap : comparing.b);
  },
  onClose: () => selected && open(selected),
});

/** Versions of the open file being compared (null = its current state), or null when comparing two files. */
let comparing: { a: Snapshot | null; b: Snapshot | null } | null = null;

const COMPARABLE = new Set(["doc", "tex", "text"]);

function closeCompare() {
  comparing = null;
  diffView.close();
}

function versionSide(snap: Snapshot | null): Side {
  const file = selected!;
  if (!snap) return { path: file.path, label: "Current version", pdf: lastPdf, doc: file.kind === "doc" };
  return {
    path: file.path,
    label: `${snap.label} · ${relativeTime(snap.time)}`,
    commit: snap.id,
    snapPath: snap.path,
    doc: file.kind === "doc" && !!snap.path?.endsWith(".tex"),
  };
}

function enterCompare() {
  exportButton.hidden = download.hidden = zoomGroup.hidden = true;
  $("logs").hidden = true; // the current build's logs would only squeeze the comparison
  focusPane("preview");
}

async function compareVersions(a: Snapshot | null, b: Snapshot | null) {
  if (!selected || !COMPARABLE.has(selected.kind)) return toast("Only LaTeX and text files can be compared");
  comparing = { a, b };
  versions.showViewing(a); // the version strip marks the "before" side
  enterCompare();
  const options = [
    { value: "now", label: "Current version", meta: "live", icon: "●", kind: "current" },
    ...versions.all.map((s) => ({ value: s.id, label: s.label, meta: `${s.author} · ${relativeTime(s.time)}`, icon: KIND_ICONS[s.kind], kind: s.kind })),
  ];
  await diffView.show(versionSide(a), versionSide(b), options, [a?.id ?? "now", b?.id ?? "now"]);
}

/** C: what changed since the last version that differs from the file as it is now. */
async function compareWithPrevious() {
  if (!selected || !COMPARABLE.has(selected.kind)) return toast("Open a LaTeX or text file to compare its versions");
  if (!versions.enabled) return toast("Version history covers files in latex/");
  if (versions.viewing) return compareVersions(versions.viewing, null);
  const file = selected;
  const snaps = (await versions.load()).filter((s) => s.path);
  const text = async (url: string) => {
    const res = await fetch(url).catch(() => null);
    return res?.ok ? res.text() : null;
  };
  const now = await text(`/api/file?path=${encodeURIComponent(file.path)}&t=${Date.now()}`);
  // The newest snapshots often match the file as it is (they were taken from it); skip those.
  for (const snap of snaps.slice(0, 25)) {
    const then = await text(`/api/history/file?commit=${snap.id}&path=${encodeURIComponent(snap.path!)}`);
    if (selected?.path !== file.path) return; // opened something else meanwhile
    if (then !== now) return compareVersions(snap, null);
  }
  toast(snaps.length ? `No earlier version of ${file.name} differs from it` : `No earlier versions of ${file.name} yet`);
}

/** Compare the open file with another one (both as they are now). */
function compareWithFile() {
  const from = selected;
  if (!from || !COMPARABLE.has(from.kind)) return toast("Open a LaTeX or text file to compare");
  const others = tree.files().filter((f) => f.path !== from.path && COMPARABLE.has(f.kind));
  const rank = (f: FileNode) => (f.kind === from.kind ? 0 : 1); // same kind first: two documents get the reader view
  openPalette({
    placeholder: `Compare ${from.name} with…`,
    emptyText: "No other files to compare with",
    items: others.sort((x, y) => rank(x) - rank(y) || x.path.localeCompare(y.path)).map((f) => ({ label: f.path, run: () => compareFiles(from, f) })),
  });
}

function compareFiles(a: FileNode, b: FileNode) {
  closeCompare();
  leaveSnapshot();
  enterCompare();
  const side = (f: FileNode): Side => ({ path: f.path, label: f.path, pdf: f.path === selected?.path ? lastPdf : null, doc: f.kind === "doc" });
  diffView.show(side(a), side(b));
}

function toggleCompare() {
  if (diffView.active) selected && open(selected);
  else compareWithPrevious();
}

// ---------- actions ----------

async function exportPdf() {
  if (!selected || selected.kind !== "doc" || !lastPdf) return toast("Open a document that compiles to save its PDF");
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
}
exportButton.onclick = exportPdf;

/** Claude runs in latex/, so mention files relative to it (absolute for anything elsewhere). */
function mention(file: FileNode | undefined) {
  if (!file) return;
  const [rootKey, ...rest] = file.path.split("/");
  const rel = rootKey === "latex" ? rest.join("/") : `${roots[rootKey!] ?? rootKey}/${rest.join("/")}`;
  focusPane("claude");
  claude.paste(`@${rel.includes(" ") ? `"${rel}"` : rel} `);
}

async function copyPath(file: FileNode | undefined) {
  if (!file) return;
  try {
    await navigator.clipboard.writeText(file.path);
    toast(`Copied ${file.path}`);
  } catch {
    toast("Couldn't access the clipboard");
  }
}

function quickOpen() {
  const rank = (p: string) => {
    const i = recent.indexOf(p);
    return i < 0 ? Infinity : i;
  };
  const files = tree.files().sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
  openPalette({
    placeholder: "Go to file…",
    emptyText: "No matching files",
    items: files.map((f) => ({ label: f.path, run: () => open(f) })),
  });
}

function commandPalette() {
  openPalette({
    placeholder: "Run a command…",
    items: COMMANDS.filter((c) => !c.when || c.when()).map((c) => ({
      label: c.title,
      hint: c.keys ? label(c.keys) : undefined,
      run: c.run,
    })),
  });
}

// ---------- panes & focus ----------

type PaneName = "tree" | "claude" | "preview";
const PANES: Record<PaneName, HTMLElement> = { tree: $("tree-pane"), claude: $("claude-pane"), preview: $("preview-pane") };
const ORDER: PaneName[] = ["tree", "claude", "preview"];
const workspace = $("workspace");
let focusedPane: PaneName | null = null;

function markFocused(name: PaneName) {
  focusedPane = name;
  for (const n of ORDER) PANES[n].toggleAttribute("data-focused", n === name);
}

// Whichever pane contains the focused element gets the indicator (covers mouse clicks).
document.addEventListener("focusin", (e) => {
  const name = ORDER.find((n) => PANES[n].contains(e.target as Node));
  if (name) markFocused(name);
});

function focusPane(name: PaneName) {
  if (PANES[name].hidden) setPaneVisible(name, true);
  markFocused(name); // don't rely on focusin alone: it doesn't fire while the window itself is unfocused
  if (workspace.dataset.zoom && workspace.dataset.zoom !== name) workspace.dataset.zoom = name;
  if (name === "claude") claude.focus();
  else PANES[name].focus({ preventScroll: true });
}

function cyclePane(dir: 1 | -1) {
  const visible = ORDER.filter((n) => !PANES[n].hidden);
  const at = focusedPane ? visible.indexOf(focusedPane) : 0;
  focusPane(visible[(at + dir + visible.length) % visible.length]!);
}

/** Leader z: give the focused pane the whole window, and back. */
function toggleZoomPane() {
  if (workspace.dataset.zoom) delete workspace.dataset.zoom;
  else if (focusedPane) workspace.dataset.zoom = focusedPane;
  for (const n of ORDER) PANES[n].toggleAttribute("data-zoomed", workspace.dataset.zoom === n);
  if (focusedPane) focusPane(focusedPane);
}

const TOGGLES: Partial<Record<PaneName, HTMLElement>> = { tree: $("toggle-tree"), claude: $("toggle-claude") };

function setPaneVisible(name: PaneName, visible: boolean) {
  const pane = PANES[name];
  const splitter = pane.nextElementSibling as HTMLElement;
  pane.hidden = splitter.hidden = !visible;
  if (name === "tree") $("tree-rail").hidden = visible; // collapsed files leave a slim rail to reopen them
  TOGGLES[name]?.classList.toggle("on", visible);
  storage(pane.id, visible ? "1" : "0");
  if (visible && name === "claude") claude.focus();
  if (!visible && focusedPane === name) focusPane("preview");
}
const togglePane = (name: PaneName) => setPaneVisible(name, PANES[name].hidden !== false);

$("toggle-tree").onclick = () => togglePane("tree");
$("collapse-tree").onclick = () => setPaneVisible("tree", false);
$("expand-tree").onclick = () => focusPane("tree");
$("toggle-claude").onclick = () => togglePane("claude");
setPaneVisible("tree", storage("tree-pane") !== "0");
setPaneVisible("claude", storage("claude-pane") !== "0");

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

// ---------- commands & keys ----------

function toggleAgentFiles(visible: boolean) {
  tree.setAgentFilesVisible(visible);
  toast(visible ? "Agent memory shown in Files (CLAUDE.md, memory/)" : "Agent memory hidden");
  if (visible) focusPane("tree");
}

function restartClaude(start: ClaudeStart) {
  setPaneVisible("claude", true);
  claude.restart(start);
  markFocused("claude");
}

type Command = { title: string; keys?: string; run: () => void; when?: () => boolean; group?: string };
const isDoc = () => selected?.kind === "doc";

const COMMANDS: Command[] = [
  { title: "Go to file…", keys: "mod+p", run: quickOpen },
  { title: "Save PDF to resumes/", keys: "mod+s", run: exportPdf, when: isDoc },
  { title: "Download PDF", run: () => download.click(), when: () => !download.hidden },
  { title: "Mention open file in Claude", run: () => mention(selected ?? undefined), when: () => !!selected },
  { title: "Copy path of open file", run: () => copyPath(selected ?? undefined), when: () => !!selected },
  { title: "Show agent memory", run: () => toggleAgentFiles(true), when: () => !tree.agentFilesVisible },
  { title: "Hide agent memory", run: () => toggleAgentFiles(false), when: () => tree.agentFilesVisible },
  {
    title: "Reveal open file in tree",
    run: () => {
      tree.setOpened(selected!.path);
      focusPane("tree");
    },
    when: () => !!selected,
  },
  { title: "Focus files", keys: `${LEADER} 1`, run: () => focusPane("tree") },
  { title: "Focus Claude", keys: `${LEADER} 2`, run: () => focusPane("claude") },
  { title: "Focus preview", keys: `${LEADER} 3`, run: () => focusPane("preview") },
  { title: "Zoom focused pane", keys: `${LEADER} z`, run: toggleZoomPane },
  { title: "Toggle file tree", run: () => togglePane("tree") },
  { title: "Toggle Claude", run: () => togglePane("claude") },
  { title: "Toggle logs", keys: "L", run: preview.toggleLogs, when: isDoc },
  { title: "Version history", keys: "H", run: () => versions.toggle(), when: () => historyEnabled && !!selected?.path.startsWith("latex/") },
  { title: "Back to current version", run: () => selected && open(selected), when: () => !!versions.viewing && !diffView.active },
  { title: "Compare with previous version", keys: "C", run: compareWithPrevious, when: () => versions.enabled && !diffView.active },
  { title: "Compare with current version", run: () => versions.viewing && compareVersions(versions.viewing, null), when: () => !!versions.viewing && !diffView.active },
  { title: "Compare with another file…", run: compareWithFile, when: () => !!selected && COMPARABLE.has(selected.kind) },
  { title: "Close comparison", keys: "escape", run: () => selected && open(selected), when: () => diffView.active },
  { title: "Next change", keys: "] c", run: () => diffView.step(1), when: () => diffView.active },
  { title: "Previous change", keys: "[ c", run: () => diffView.step(-1), when: () => diffView.active },
  { title: "Compare: reader view", run: () => diffView.setMode("reader"), when: () => diffView.active && diffView.mode !== "reader" },
  { title: "Compare: source", keys: "S", run: () => diffView.setMode("source"), when: () => diffView.active && diffView.mode !== "source" },
  { title: "Toggle version bar", keys: "V", run: () => versions.toggleStrip(), when: () => historyEnabled },
  { title: "Older version", keys: ",", run: () => versions.step(-1), when: () => historyEnabled },
  { title: "Newer version", keys: ".", run: () => versions.step(1), when: () => historyEnabled },
  { title: "Zoom in", keys: "+", run: () => preview.stepZoom(1) },
  { title: "Zoom out", keys: "-", run: () => preview.stepZoom(-1) },
  { title: "Fit to width", keys: "=", run: preview.fitWidth },
  { title: "Claude: new conversation", run: () => restartClaude("new") },
  { title: "Claude: resume a previous conversation…", run: () => restartClaude("resume") },
  { title: "Claude: continue the most recent conversation", run: () => restartClaude("continue") },
  { title: "Keyboard shortcuts", keys: "?", run: toggleCheatsheet },
];

const TREE_KEYS: Bindings = {
  j: () => tree.move(1),
  k: () => tree.move(-1),
  arrowdown: () => tree.move(1),
  arrowup: () => tree.move(-1),
  h: () => tree.left(),
  l: () => tree.right(),
  arrowleft: () => tree.left(),
  arrowright: () => tree.right(),
  enter: () => tree.activate(),
  o: () => tree.activate(),
  "g g": () => tree.edge("first"),
  G: () => tree.edge("last"),
  a: () => mention(tree.cursorFile()),
  y: () => copyPath(tree.cursorFile()),
  "/": quickOpen,
};

const scrollPreview = (how: preview.ScrollHow) => preview.scroll(how, diffView.active ? diffView.scroller : undefined);

const PREVIEW_KEYS: Bindings = {
  j: () => scrollPreview("down"),
  k: () => scrollPreview("up"),
  d: () => scrollPreview("half-down"),
  u: () => scrollPreview("half-up"),
  "g g": () => scrollPreview("top"),
  G: () => scrollPreview("bottom"),
  "+": () => preview.stepZoom(1),
  "-": () => preview.stepZoom(-1),
  "=": preview.fitWidth,
  L: preview.toggleLogs,
  H: () => versions.toggle(),
  V: () => versions.toggleStrip(),
  ",": () => versions.step(-1),
  ".": () => versions.step(1),
  "] e": () => preview.cycleDiagnostic(1),
  "[ e": () => preview.cycleDiagnostic(-1),
  C: toggleCompare,
  "] c": () => diffView.step(1),
  "[ c": () => diffView.step(-1),
  S: () => diffView.active && diffView.toggleMode(),
  escape: () => (diffView.active || versions.viewing) && selected && open(selected), // close a comparison, or leave an earlier version
  a: () => mention(selected ?? undefined),
};

// Keys that work in the tree and the preview (not while typing in Claude).
const SHARED_KEYS: Bindings = { "?": toggleCheatsheet };

installKeymap({
  global: {
    "mod+p": () => (paletteOpen() ? closePalette() : quickOpen()),
    "mod+shift+p": commandPalette,
    "mod+s": exportPdf,
  },
  leader: {
    h: () => cyclePane(-1),
    l: () => cyclePane(1),
    arrowleft: () => cyclePane(-1),
    arrowright: () => cyclePane(1),
    "1": () => focusPane("tree"),
    "2": () => focusPane("claude"),
    "3": () => focusPane("preview"),
    z: toggleZoomPane,
    "?": toggleCheatsheet,
  },
  pane: () =>
    focusedPane === "tree" ? { ...SHARED_KEYS, ...TREE_KEYS } : focusedPane === "preview" ? { ...SHARED_KEYS, ...PREVIEW_KEYS } : undefined,
  overlayOpen: () => paletteOpen() || !cheatsheet.hidden,
});

$("quick-open").onclick = quickOpen;
$("help").onclick = toggleCheatsheet;
for (const kbd of document.querySelectorAll<HTMLElement>("kbd[data-key]")) kbd.textContent = label(kbd.dataset.key!);
installHints();

// ---------- cheat sheet ----------

let cheatsheetReturn: HTMLElement | null = null;
function toggleCheatsheet() {
  cheatsheet.hidden = !cheatsheet.hidden;
  if (cheatsheet.hidden) return cheatsheetReturn?.focus();
  // Take focus so Esc closes the sheet instead of reaching Claude.
  cheatsheetReturn = document.activeElement as HTMLElement | null;
  renderCheatsheet();
  cheatsheet.focus();
}
cheatsheet.onkeydown = (e) => {
  if (e.key === "Escape" || e.key === "?") {
    e.preventDefault();
    toggleCheatsheet();
  }
};
cheatsheet.onmousedown = (e) => {
  if (e.target === cheatsheet) toggleCheatsheet();
};

function renderCheatsheet() {
  const sections: [string, [string, string][]][] = [
    [
      "Anywhere",
      [
        ["mod+p", "Go to file"],
        ["mod+shift+p", "Command palette"],
        ["mod+s", "Save PDF to resumes/"],
        [`${LEADER} h`, "Focus pane to the left (l: right)"],
        [`${LEADER} 1`, "Focus files (2: Claude, 3: preview)"],
        [`${LEADER} z`, "Zoom focused pane"],
      ],
    ],
    [
      "Files",
      [
        ["j", "Down (k: up)"],
        ["h", "Collapse / parent (l: expand / open)"],
        ["enter", "Open (also o)"],
        ["g g", "Top (G: bottom)"],
        ["a", "Mention file in Claude"],
        ["y", "Copy path"],
        ["/", "Go to file"],
      ],
    ],
    [
      "Preview",
      [
        ["j", "Scroll down (k: up)"],
        ["d", "Half page down (u: up)"],
        ["g g", "Top (G: bottom)"],
        ["+", "Zoom in (-: out, =: fit)"],
        ["] e", "Next error ([ e: previous)"],
        ["L", "Toggle logs"],
        ["H", "Version history"],
        [",", "Older version (.: newer)"],
        ["V", "Toggle version bar"],
        ["C", "Compare with previous version"],
        ["] c", "Next change ([ c: previous)"],
        ["S", "Reader view ↔ source diff"],
        ["escape", "Close comparison / back to current"],
        ["a", "Mention file in Claude"],
      ],
    ],
  ];
  $("cheatsheet-body").replaceChildren(
    ...sections.map(([name, rows]) => {
      const section = document.createElement("section");
      const h = document.createElement("h3");
      h.textContent = name;
      const dl = document.createElement("dl");
      for (const [keys, what] of rows) {
        const dt = document.createElement("dt");
        for (const step of label(keys).split(" ")) {
          const kbd = document.createElement("kbd");
          kbd.textContent = step;
          dt.append(kbd);
        }
        const dd = document.createElement("dd");
        dd.textContent = what;
        dl.append(dt, dd);
      }
      section.append(h, dl);
      return section;
    }),
  );
}

// ---------- misc ----------

function send(msg: object) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

connect();
focusPane(storage("claude-pane") !== "0" ? "claude" : "tree");
