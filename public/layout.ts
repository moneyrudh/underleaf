import { ClaudeTerminal } from "./terminal";
import { $, storage } from "./util";

/** The three panes: which is focused, which are shown, zoom, and the splitters between them. */

export type PaneName = "tree" | "claude" | "preview";
const PANES: Record<PaneName, HTMLElement> = { tree: $("tree-pane"), claude: $("claude-pane"), preview: $("preview-pane") };
const ORDER: PaneName[] = ["tree", "claude", "preview"];
const TOGGLES: Partial<Record<PaneName, HTMLElement>> = { tree: $("toggle-tree"), claude: $("toggle-claude") };
const workspace = $("workspace");

export const claude = new ClaudeTerminal($("terminal"));
let focusedPane: PaneName | null = null;

export const focused = () => focusedPane;

export function initLayout() {
  // Whichever pane contains the focused element gets the indicator (covers mouse clicks).
  document.addEventListener("focusin", (e) => {
    const name = ORDER.find((n) => PANES[n].contains(e.target as Node));
    if (name) markFocused(name);
  });

  $("toggle-tree").onclick = () => togglePane("tree");
  $("collapse-tree").onclick = () => setPaneVisible("tree", false);
  $("expand-tree").onclick = () => focusPane("tree");
  $("toggle-claude").onclick = () => togglePane("claude");
  setPaneVisible("tree", storage("tree-pane") !== "0");
  setPaneVisible("claude", storage("claude-pane") !== "0");

  for (const splitter of document.querySelectorAll<HTMLElement>(".splitter")) initSplitter(splitter);
}

export function markFocused(name: PaneName) {
  focusedPane = name;
  for (const n of ORDER) PANES[n].toggleAttribute("data-focused", n === name);
}

export function focusPane(name: PaneName) {
  if (PANES[name].hidden) setPaneVisible(name, true);
  markFocused(name); // don't rely on focusin alone: it doesn't fire while the window itself is unfocused
  if (workspace.dataset.zoom && workspace.dataset.zoom !== name) workspace.dataset.zoom = name;
  if (name === "claude") claude.focus();
  else PANES[name].focus({ preventScroll: true });
}

export function cyclePane(dir: 1 | -1) {
  const visible = ORDER.filter((n) => !PANES[n].hidden);
  const at = focusedPane ? visible.indexOf(focusedPane) : 0;
  focusPane(visible[(at + dir + visible.length) % visible.length]!);
}

/** Leader z: give the focused pane the whole window, and back. */
export function toggleZoomPane() {
  if (workspace.dataset.zoom) delete workspace.dataset.zoom;
  else if (focusedPane) workspace.dataset.zoom = focusedPane;
  for (const n of ORDER) PANES[n].toggleAttribute("data-zoomed", workspace.dataset.zoom === n);
  if (focusedPane) focusPane(focusedPane);
}

export function setPaneVisible(name: PaneName, visible: boolean) {
  const pane = PANES[name];
  const splitter = pane.nextElementSibling as HTMLElement;
  pane.hidden = splitter.hidden = !visible;
  if (name === "tree") $("tree-rail").hidden = visible; // collapsed files leave a slim rail to reopen them
  TOGGLES[name]?.classList.toggle("on", visible);
  storage(pane.id, visible ? "1" : "0");
  if (visible && name === "claude") claude.focus();
  if (!visible && focusedPane === name) focusPane("preview");
}

export const togglePane = (name: PaneName) => setPaneVisible(name, PANES[name].hidden !== false);

function initSplitter(splitter: HTMLElement) {
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
