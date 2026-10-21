import * as preview from "../preview/preview";
import { closePalette, openPalette, paletteOpen } from "../ui/palette";
import { installKeymap, label, LEADER, type Bindings } from "./keys";
import { copyPath, mention, quickOpen, reopen, toggleAgentFiles, tree } from "../files/open";
import { hasSaveTarget, saveAs, savePdf, saveToDownloads } from "../files/save";
import { openFolder, switchWorkspacePalette } from "../files/workspaces";
import { versions } from "../history/versions";
import { canCompare, compareVersions, compareWithFile, diffView, toggleCompare } from "../compare/compare";
import { claude, cyclePane, focused, focusPane, markFocused, setPaneVisible, togglePane, toggleZoomPane } from "./layout";
import { cheatsheetOpen, toggleCheatsheet } from "../ui/cheatsheet";
import { popoverOpen } from "../ui/popover";
import { state, ui } from "./state";
import type { ClaudeStart } from "../../shared/types";

/**
 * Every command in one registry. Keymaps, the command palette (⌘⇧P) and the cheat sheet (?)
 * are all built from it, so a shortcut can't be shown in one place and bound differently in another.
 */
export type Scope = "global" | "leader" | "tree" | "preview";

export type Command = {
  /** For menus that point at a command (data-command="…"). */
  id?: string;
  title: string;
  run: () => void;
  /** Keys in `scope` (the first is the one shown). Leader keys are written without the leader. */
  keys?: string[];
  scope?: Scope | Scope[];
  /** Offered in the palette only when this holds (key bindings always fire). */
  when?: () => boolean;
  /** Left out of the palette (movement keys and the like). */
  palette?: false;
  /** Cheat-sheet row: commands with the same row text share one row ("j / k  Down / up"). false hides it. */
  sheet?: string | false;
};

const isDoc = () => state.selected?.kind === "doc";
const inLatex = () => state.historyEnabled && !!state.selected?.path.startsWith("latex/");
const scrollPreview = (how: preview.ScrollHow) => preview.scroll(how, diffView.active ? diffView.scroller : undefined);

function restartClaude(start: ClaudeStart) {
  setPaneVisible("claude", true);
  claude.restart(start);
  markFocused("claude");
}

export const COMMANDS: Command[] = [
  // ---------- anywhere ----------
  { title: "Go to file…", keys: ["mod+p"], scope: "global", run: () => (paletteOpen() ? closePalette() : quickOpen()) },
  { title: "Command palette", keys: ["mod+shift+p"], scope: "global", run: commandPalette, palette: false },
  { id: "save", title: "Save PDF", keys: ["mod+s"], scope: "global", run: savePdf, when: isDoc },
  { id: "save-as", title: "Save PDF As…", keys: ["mod+shift+s"], scope: "global", run: saveAs, when: isDoc },
  { id: "save-again", title: "Save again", run: savePdf, when: () => isDoc() && hasSaveTarget(), palette: false },
  { id: "save-downloads", title: "Save PDF to Downloads", run: saveToDownloads, when: isDoc },
  { id: "open-folder", title: "Open folder…", run: openFolder },
  { id: "switch-workspace", title: "Switch workspace…", run: switchWorkspacePalette, when: () => (state.workspace?.recent.length ?? 0) > 1 },
  { title: "Focus pane to the left", keys: ["h", "arrowleft"], scope: "leader", run: () => cyclePane(-1), palette: false, sheet: "Focus pane left / right" },
  { title: "Focus pane to the right", keys: ["l", "arrowright"], scope: "leader", run: () => cyclePane(1), palette: false, sheet: "Focus pane left / right" },
  { title: "Focus files", keys: ["1"], scope: "leader", run: () => focusPane("tree"), sheet: "Focus files / Claude / preview" },
  { title: "Focus Claude", keys: ["2"], scope: "leader", run: () => focusPane("claude"), sheet: "Focus files / Claude / preview" },
  { title: "Focus preview", keys: ["3"], scope: "leader", run: () => focusPane("preview"), sheet: "Focus files / Claude / preview" },
  { title: "Zoom focused pane", keys: ["z"], scope: "leader", run: toggleZoomPane },
  { title: "Keyboard shortcuts", keys: ["?"], scope: ["leader", "tree", "preview"], run: toggleCheatsheet },

  // ---------- files ----------
  { title: "Down", keys: ["j", "arrowdown"], scope: "tree", run: () => tree.move(1), palette: false, sheet: "Down / up" },
  { title: "Up", keys: ["k", "arrowup"], scope: "tree", run: () => tree.move(-1), palette: false, sheet: "Down / up" },
  { title: "Collapse / parent", keys: ["h", "arrowleft"], scope: "tree", run: () => tree.left(), palette: false, sheet: "Collapse / expand or open" },
  { title: "Expand / open", keys: ["l", "arrowright"], scope: "tree", run: () => tree.right(), palette: false, sheet: "Collapse / expand or open" },
  { title: "Open", keys: ["enter", "o"], scope: "tree", run: () => tree.activate(), palette: false },
  { title: "Top", keys: ["g g"], scope: "tree", run: () => tree.edge("first"), palette: false, sheet: "Top / bottom" },
  { title: "Bottom", keys: ["G"], scope: "tree", run: () => tree.edge("last"), palette: false, sheet: "Top / bottom" },
  { title: "Mention file in Claude", keys: ["a"], scope: "tree", run: () => mention(tree.cursorFile()), palette: false },
  { title: "Copy path", keys: ["y"], scope: "tree", run: () => copyPath(tree.cursorFile()), palette: false },
  { title: "Go to file", keys: ["/"], scope: "tree", run: quickOpen, palette: false },

  // ---------- preview ----------
  { title: "Scroll down", keys: ["j"], scope: "preview", run: () => scrollPreview("down"), palette: false, sheet: "Scroll down / up" },
  { title: "Scroll up", keys: ["k"], scope: "preview", run: () => scrollPreview("up"), palette: false, sheet: "Scroll down / up" },
  { title: "Half page down", keys: ["d"], scope: "preview", run: () => scrollPreview("half-down"), palette: false, sheet: "Half page down / up" },
  { title: "Half page up", keys: ["u"], scope: "preview", run: () => scrollPreview("half-up"), palette: false, sheet: "Half page down / up" },
  { title: "Top", keys: ["g g"], scope: "preview", run: () => scrollPreview("top"), palette: false, sheet: "Top / bottom" },
  { title: "Bottom", keys: ["G"], scope: "preview", run: () => scrollPreview("bottom"), palette: false, sheet: "Top / bottom" },
  { title: "Zoom in", keys: ["+"], scope: "preview", run: () => preview.stepZoom(1), sheet: "Zoom in / out / fit" },
  { title: "Zoom out", keys: ["-"], scope: "preview", run: () => preview.stepZoom(-1), sheet: "Zoom in / out / fit" },
  { title: "Fit to width", keys: ["="], scope: "preview", run: preview.fitWidth, sheet: "Zoom in / out / fit" },
  { title: "Next error", keys: ["] e"], scope: "preview", run: () => preview.cycleDiagnostic(1), palette: false, sheet: "Next / previous error" },
  { title: "Previous error", keys: ["[ e"], scope: "preview", run: () => preview.cycleDiagnostic(-1), palette: false, sheet: "Next / previous error" },
  { title: "Toggle logs", keys: ["L"], scope: "preview", run: preview.toggleLogs, when: isDoc },
  { title: "Version history", keys: ["H"], scope: "preview", run: () => versions.toggle(), when: inLatex },
  { id: "version-bar", title: "Toggle version bar", keys: ["V"], scope: "preview", run: () => versions.toggleStrip(), when: () => versions.enabled }, // the bar only exists for files with history
  { title: "Older version", keys: [","], scope: "preview", run: () => versions.step(-1), when: () => state.historyEnabled, sheet: "Older / newer version" },
  { title: "Newer version", keys: ["."], scope: "preview", run: () => versions.step(1), when: () => state.historyEnabled, sheet: "Older / newer version" },
  { id: "compare-previous", title: "Compare with previous version", keys: ["C"], scope: "preview", run: toggleCompare, when: () => versions.enabled && canCompare() && !diffView.active },
  { title: "Next change", keys: ["] c"], scope: "preview", run: () => diffView.step(1), when: () => diffView.active, sheet: "Next / previous change" },
  { title: "Previous change", keys: ["[ c"], scope: "preview", run: () => diffView.step(-1), when: () => diffView.active, sheet: "Next / previous change" },
  { title: "Compare: switch reader / source", keys: ["S"], scope: "preview", run: () => diffView.active && diffView.toggleMode(), when: () => diffView.active, sheet: "Reader view ↔ source diff" },
  {
    title: "Close comparison / back to current",
    keys: ["escape"],
    scope: "preview",
    run: () => (diffView.active || versions.viewing) && reopen(),
    when: () => diffView.active || !!versions.viewing,
  },
  { id: "mention", title: "Mention open file in Claude", keys: ["a"], scope: "preview", run: () => mention(state.selected), when: () => !!state.selected },

  // ---------- palette only ----------
  { title: "Download PDF", run: () => ui.download.click(), when: () => !ui.download.hidden },
  { id: "copy-path", title: "Copy path of open file", run: () => copyPath(state.selected), when: () => !!state.selected },
  { title: "Compare with current version", run: () => versions.viewing && compareVersions(versions.viewing, null), when: () => !!versions.viewing && !diffView.active },
  { id: "compare-file", title: "Compare with another file…", run: compareWithFile, when: canCompare },
  { title: "Show agent memory", run: () => toggleAgentFiles(true), when: () => !tree.agentFilesVisible },
  { title: "Hide agent memory", run: () => toggleAgentFiles(false), when: () => tree.agentFilesVisible },
  {
    title: "Reveal open file in tree",
    run: () => {
      tree.setOpened(state.selected!.path);
      focusPane("tree");
    },
    when: () => !!state.selected,
  },
  { title: "Toggle file tree", run: () => togglePane("tree") },
  { title: "Toggle Claude", run: () => togglePane("claude") },
  { title: "Claude: new conversation", run: () => restartClaude("new") },
  { title: "Claude: resume a previous conversation…", run: () => restartClaude("resume") },
  { title: "Claude: continue the most recent conversation", run: () => restartClaude("continue") },
];

const byId = (id: string) => COMMANDS.find((c) => c.id === id);
export const runCommand = (id: string) => byId(id)?.run();
export const commandAvailable = (id: string) => {
  const c = byId(id);
  return !!c && (!c.when || c.when());
};

/** Commands offered in the palettes, with their shortcut as a hint. */
export function paletteCommands() {
  return COMMANDS.filter((c) => c.palette !== false && (!c.when || c.when())).map((c) => {
    const scope = scopesOf(c)[0];
    return { label: c.title, hint: c.keys && scope ? keyLabel(c, scope) : undefined, run: c.run };
  });
}

export const scopesOf = (c: Command): Scope[] => (c.scope === undefined ? [] : Array.isArray(c.scope) ? c.scope : [c.scope]);

/** How a command's main key is written for people, in a given scope ("⌃Space 1", "⌘P", "g g"). */
export function keyLabel(c: Command, scope: Scope): string {
  const key = c.keys![0]!;
  return label(scope === "leader" ? `${LEADER} ${key}` : key);
}

function commandPalette() {
  openPalette({ placeholder: "Run a command…", items: paletteCommands() });
}

export function installCommands() {
  const maps: Record<Scope, Bindings> = { global: {}, leader: {}, tree: {}, preview: {} };
  for (const c of COMMANDS) for (const scope of scopesOf(c)) for (const key of c.keys ?? []) maps[scope][key] = c.run;
  installKeymap({
    global: maps.global,
    leader: maps.leader,
    pane: () => (focused() === "tree" ? maps.tree : focused() === "preview" ? maps.preview : undefined),
    overlayOpen: () => paletteOpen() || cheatsheetOpen() || popoverOpen(),
  });
}
