import { $ } from "./util";

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
/** Ctrl+Space everywhere: terminals send it as NUL, which Claude Code doesn't use. */
export const LEADER = isMac ? "ctrl+space" : "mod+space";

type Handler = () => void;
export type Bindings = Record<string, Handler>;

export type Keymap = {
  /** Fire everywhere, even while typing in Claude or an input. */
  global: Bindings;
  /** Fire on the key pressed right after the leader. */
  leader: Bindings;
  /** Vim-style keys for whichever pane has focus; space-separated sequences like "g g" work. */
  pane: () => Bindings | undefined;
  /** True while an overlay (palette, cheat sheet) owns the keyboard. */
  overlayOpen: () => boolean;
};

/** "mod" is ⌘ on macOS and Ctrl elsewhere. Printable keys stay as typed ("G", "?", "+"). */
export function normalize(e: KeyboardEvent): string {
  let key = e.key === " " ? "space" : e.key.length === 1 ? e.key : e.key.toLowerCase();
  const mods: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) mods.push("mod");
  if (isMac && e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey && (mods.length > 0 || key.length > 1)) mods.push("shift");
  if (mods.length > 0 && key.length === 1) key = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : key.toLowerCase();
  return [...mods, key].join("+");
}

const NAMES: Record<string, string> = isMac
  ? { mod: "⌘", ctrl: "⌃", shift: "⇧", alt: "⌥", space: "Space", escape: "Esc", enter: "↵" }
  : { mod: "Ctrl+", ctrl: "Ctrl+", shift: "Shift+", alt: "Alt+", space: "Space", escape: "Esc", enter: "Enter" };

/** Human-readable label for a binding: "mod+shift+p" → "⌘⇧P", "g g" → "g g". */
export function label(binding: string): string {
  return binding
    .split(" ")
    .map((step) => {
      if (step === "+") return "+";
      const parts = step.split("+");
      const chord = parts.length > 1;
      return parts.map((p) => NAMES[p] ?? (chord ? p.toUpperCase() : p)).join("");
    })
    .join(" ");
}

function isTyping(el: Element | null) {
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);
}

export function installKeymap(keymap: Keymap) {
  const chip = $("leader");
  let leaderActive = false;
  let leaderTimer: ReturnType<typeof setTimeout>;
  let pending = "";
  let pendingTimer: ReturnType<typeof setTimeout>;

  const endLeader = () => {
    leaderActive = false;
    chip.hidden = true;
    clearTimeout(leaderTimer);
  };

  const consume = (e: KeyboardEvent, run: Handler) => {
    e.preventDefault();
    e.stopPropagation(); // keep it away from xterm and native button activation
    run();
  };

  // Capture phase: we see keys before the terminal's textarea does.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing || ["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const key = normalize(e);

      if (leaderActive) {
        endLeader();
        const run = keymap.leader[key];
        e.preventDefault();
        e.stopPropagation();
        run?.();
        return;
      }
      if (key === LEADER) {
        return consume(e, () => {
          leaderActive = true;
          chip.hidden = false;
          leaderTimer = setTimeout(endLeader, 1500);
        });
      }

      const global = keymap.global[key];
      if (global) return consume(e, global);
      if (keymap.overlayOpen() || isTyping(document.activeElement)) return;

      const bindings = keymap.pane();
      if (!bindings) return;
      const candidate = pending ? `${pending} ${key}` : key;
      clearTimeout(pendingTimer);
      pending = "";
      if (bindings[candidate]) return consume(e, bindings[candidate]);
      if (Object.keys(bindings).some((b) => b.startsWith(`${candidate} `))) {
        e.preventDefault();
        pending = candidate;
        pendingTimer = setTimeout(() => (pending = ""), 1000);
        return;
      }
      if (candidate !== key && bindings[key]) consume(e, bindings[key]); // abandoned sequence: try the key alone
    },
    true,
  );
}
