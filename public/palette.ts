import { $ } from "./util";

export type PaletteItem = {
  /** Text that's matched and shown, e.g. "latex/amazon/main.tex" or "Save PDF". */
  label: string;
  /** Right-aligned hint, e.g. a shortcut. */
  hint?: string;
  run: () => void;
};

type Options = { placeholder: string; items: PaletteItem[]; emptyText?: string };

const overlay = $("palette");
const input = $<HTMLInputElement>("palette-input");
const list = $("palette-list");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

let items: PaletteItem[] = [];
let shown: { item: PaletteItem; marks: number[] }[] = [];
let active = 0;
let restoreFocus: HTMLElement | null = null;
let emptyText = "";

export const paletteOpen = () => !overlay.hidden;

/** Fuzzy picker used by quick-open and the command palette. */
export function openPalette(opts: Options) {
  if (!paletteOpen()) restoreFocus = document.activeElement as HTMLElement | null;
  items = opts.items;
  emptyText = opts.emptyText ?? "No matches";
  input.placeholder = opts.placeholder;
  input.value = "";
  overlay.hidden = false;
  if (!reduceMotion.matches) overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "ease-out" });
  input.focus();
  update();
}

export function closePalette() {
  overlay.hidden = true;
  restoreFocus?.focus();
}

function update() {
  const query = input.value.trim();
  shown = items
    .map((item) => ({ item, ...score(item.label, query) }))
    .filter((r) => r.score > -Infinity)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
  active = 0;
  render();
}

function render() {
  if (shown.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = emptyText;
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...shown.map(({ item, marks }, i) => {
      const li = document.createElement("li");
      li.classList.toggle("active", i === active);
      const text = document.createElement("span");
      text.className = "label";
      // Highlight matched characters; built with text nodes since labels can be file names.
      let last = 0;
      for (const m of marks) {
        text.append(item.label.slice(last, m));
        const mark = document.createElement("mark");
        mark.textContent = item.label[m]!;
        text.append(mark);
        last = m + 1;
      }
      text.append(item.label.slice(last));
      li.append(text);
      if (item.hint) {
        const hint = document.createElement("kbd");
        hint.textContent = item.hint;
        li.append(hint);
      }
      li.onmousemove = () => {
        if (active !== i) {
          active = i;
          render();
        }
      };
      li.onclick = () => choose(i);
      return li;
    }),
  );
  list.children[active]?.scrollIntoView({ block: "nearest" });
}

function choose(i: number) {
  const pick = shown[i];
  if (!pick) return;
  closePalette();
  pick.item.run();
}

function move(delta: number) {
  if (shown.length === 0) return;
  active = (active + delta + shown.length) % shown.length;
  render();
}

input.oninput = update;
input.onkeydown = (e) => {
  const ctrl = e.ctrlKey && !e.metaKey;
  if (e.key === "ArrowDown" || (ctrl && (e.key === "n" || e.key === "j"))) move(1);
  else if (e.key === "ArrowUp" || (ctrl && (e.key === "p" || e.key === "k"))) move(-1);
  else if (e.key === "Enter") choose(active);
  else if (e.key === "Escape") closePalette();
  else return;
  e.preventDefault();
};
overlay.onmousedown = (e) => {
  if (e.target === overlay) closePalette();
};

/**
 * Subsequence match. Rewards consecutive runs, matches at word starts
 * (after / . - _ space), and matches inside the last path segment.
 */
function score(text: string, query: string): { score: number; marks: number[] } {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, marks: [] };
  const lower = text.toLowerCase();
  // Greedy matching from the first occurrence can miss a better alignment
  // ("ama" should prefer "amazon" over the "a" in "latex"), so try every start.
  let best = { score: -Infinity, marks: [] as number[] };
  for (let start = lower.indexOf(q[0]!); start >= 0; start = lower.indexOf(q[0]!, start + 1)) {
    const result = scoreFrom(text, lower, q, start);
    if (result.score > best.score) best = result;
  }
  return best;
}

function scoreFrom(text: string, lower: string, q: string, start: number): { score: number; marks: number[] } {
  const nameStart = text.lastIndexOf("/") + 1;
  const marks: number[] = [];
  let total = 0;
  let from = start;
  for (const ch of q) {
    const at = lower.indexOf(ch, from);
    if (at < 0) return { score: -Infinity, marks: [] };
    const prev = marks[marks.length - 1];
    total += 1;
    if (prev !== undefined && at === prev + 1) total += 4;
    if (at === 0 || "/.-_ ".includes(text[at - 1]!)) total += 3;
    if (at >= nameStart) total += 2;
    total -= (at - from) * 0.05; // gaps cost a little
    marks.push(at);
    from = at + 1;
  }
  return { score: total - text.length * 0.01, marks };
}
