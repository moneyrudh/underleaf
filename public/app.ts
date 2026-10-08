import type { DirNode, FileNode } from "../src/workspace";
import { FileTree } from "./tree";
import { ClaudeTerminal } from "./terminal";
import * as preview from "./preview";
import { closePalette, openPalette, paletteOpen } from "./palette";
import { installKeymap, label, LEADER, type Bindings } from "./keys";
import { $, formatBytes, storage, toast } from "./util";

type Message =
  | { type: "tree"; trees: DirNode[]; docs: string[]; roots: Record<string, string> }
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
    return onTree(msg.trees);
  }
  if (!selected || msg.doc !== selected.path) return;

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
  } else if (now.kind !== selected.kind || (now.kind !== "doc" && now.mtime !== selected.mtime)) {
    open(now); // changed on disk → refresh the preview (docs refresh via compile messages)
  } else {
    selected = now;
  }
}

function open(file: FileNode) {
  const switching = file.path !== selected?.path;
  selected = file;
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
  if (file && file.path !== selected?.path) open(file);
});

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
  TOGGLES[name]?.classList.toggle("on", visible);
  storage(pane.id, visible ? "1" : "0");
  if (visible && name === "claude") claude.focus();
  if (!visible && focusedPane === name) focusPane("preview");
}
const togglePane = (name: PaneName) => setPaneVisible(name, PANES[name].hidden !== false);

$("toggle-tree").onclick = () => togglePane("tree");
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

type Command = { title: string; keys?: string; run: () => void; when?: () => boolean; group?: string };
const isDoc = () => selected?.kind === "doc";

const COMMANDS: Command[] = [
  { title: "Go to file…", keys: "mod+p", run: quickOpen },
  { title: "Save PDF to resumes/", keys: "mod+s", run: exportPdf, when: isDoc },
  { title: "Download PDF", run: () => download.click(), when: () => !download.hidden },
  { title: "Mention open file in Claude", run: () => mention(selected ?? undefined), when: () => !!selected },
  { title: "Copy path of open file", run: () => copyPath(selected ?? undefined), when: () => !!selected },
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
  { title: "Zoom in", keys: "+", run: () => preview.stepZoom(1) },
  { title: "Zoom out", keys: "-", run: () => preview.stepZoom(-1) },
  { title: "Fit to width", keys: "=", run: preview.fitWidth },
  { title: "Restart Claude session", run: () => (setPaneVisible("claude", true), claude.restart()) },
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

const PREVIEW_KEYS: Bindings = {
  j: () => preview.scroll("down"),
  k: () => preview.scroll("up"),
  d: () => preview.scroll("half-down"),
  u: () => preview.scroll("half-up"),
  "g g": () => preview.scroll("top"),
  G: () => preview.scroll("bottom"),
  "+": () => preview.stepZoom(1),
  "-": () => preview.stepZoom(-1),
  "=": preview.fitWidth,
  L: preview.toggleLogs,
  "] e": () => preview.cycleDiagnostic(1),
  "[ e": () => preview.cycleDiagnostic(-1),
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
