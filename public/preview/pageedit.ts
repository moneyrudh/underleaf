import { diffArrays } from "diff";
import type { PageViewport } from "pdfjs-dist";
import type { ChangeSpec } from "@codemirror/state";
import { wordsFrom, type TextRun, type Word } from "../compare/diffcore";
import { buildSourceMap, escapeTyped, type Link, type SourceMap, type SourceWord } from "./sourcemap";
import { editor, saveFile, sha256 } from "../editor/editor";
import { state } from "../core/state";
import { toast } from "../core/util";
import { API, url } from "../../shared/protocol";

/**
 * Editing on the page: the PDF the preview shows is the real compiled document, and its text can be
 * changed where it stands. What you edit is a component of the source (sourcemap.ts): a job title, a
 * place, a whole bullet, a paragraph. Hovering outlines it, on every printed line it covers; clicking
 * it opens a text box over it. When you're done (Enter, or clicking away), the change is worked out
 * word by word and written into the LaTeX at exactly the words that printed it: the commands around
 * them are left alone, characters LaTeX treats specially are escaped, and nothing that would cross
 * markup (a brace, a command) is ever written. It saves like any edit (a version, a rebuild), and the
 * page redraws with the result a moment later.
 *
 * A component with a link (\href) also shows the link's address under the text box, so it can be
 * changed too (a mailto: link shows just the email address).
 *
 * Only text the source spells out can be edited here: not bullets, icons, page numbers, math, or
 * words a macro generates. Structure (new sections, items, commands) is for Source.
 */

export type PageText = { wrap: HTMLElement; viewport: PageViewport; runs: TextRun[] };

type Rect = { left: number; top: number; right: number; bottom: number };
/** One component's words on one page, and the box of each printed line it covers. */
type Target = { page: PageText; words: number[]; lines: Rect[] };

let generation = 0;

/** Lay the editing layer over freshly rendered pages. */
export async function attachPageEditing(pages: PageText[]) {
  const gen = ++generation;
  const doc = state.selected;
  if (!doc || doc.kind !== "doc" || !pages.length) return;

  const words = wordsFrom(pages.flatMap((p) => p.runs));
  const load = async (path: string) => {
    const res = await fetch(url(API.file, { path, t: Date.now() })).catch(() => null); // never a cached copy
    return res?.ok ? res.text() : null;
  };
  const map = await buildSourceMap(doc.path, load, words);
  if (gen !== generation || !map) return;

  const targets = targetsOf(words, map, pages);
  for (const p of pages) {
    const layer = document.createElement("div");
    layer.className = "edit-layer";
    p.wrap.append(layer);
    for (const target of targets.filter((t) => t.page === p)) {
      const el = document.createElement("div");
      el.className = "edit-target";
      el.dataset.text = target.words.map((w) => words[w]!.key).join(" ");
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", `Edit: ${el.dataset.text}`);
      for (const line of target.lines) {
        const rect = document.createElement("div");
        rect.className = "edit-rect";
        place(rect, line);
        el.append(rect);
      }
      el.onclick = (e) => {
        e.stopPropagation();
        openTarget(target, el, words, map);
      };
      layer.append(el);
    }
  }
}

/** Group the page's mapped words by source component (per page), with a box for each printed line. */
function targetsOf(words: Word[], map: SourceMap, pages: PageText[]): Target[] {
  const byKey = new Map<string, Target>();
  words.forEach((w, i) => {
    const source = map.at(i);
    if (!source) return; // nothing to edit: a bullet, an icon, text the template makes
    const box = w.boxes[0]!;
    const page = pages.find((p) => p.runs.some((r) => r.page === box.page));
    if (!page) return;
    const key = `${source.component}@${box.page}`;
    const target = byKey.get(key) ?? { page, words: [], lines: [] };
    byKey.set(key, target);
    target.words.push(i);
    const r = rectOf(w, page);
    const line = target.lines.find((l) => Math.abs((l.top + l.bottom) / 2 - (r.top + r.bottom) / 2) < (r.bottom - r.top) * 0.5);
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else target.lines.push(r);
  });
  return [...byKey.values()];
}

/** A word's box on its (first) line, in CSS pixels. */
function rectOf(w: Word, page: PageText): Rect {
  const box = w.boxes[0]!;
  const last = w.boxes.filter((b) => b.page === box.page && Math.abs(b.y - box.y) < box.h * 0.5).at(-1)!;
  const [x0, top] = page.viewport.convertToViewportPoint(box.x0, box.y + box.h * 0.85);
  const [x1, bottom] = page.viewport.convertToViewportPoint(last.x1, box.y - box.h * 0.25);
  return { left: x0!, top: top!, right: x1!, bottom: bottom! };
}

function place(el: HTMLElement, r: Rect, extraRight = 0) {
  el.style.left = `${r.left - 2}px`;
  el.style.top = `${r.top - 1}px`;
  el.style.width = `${r.right - r.left + 4 + extraRight}px`;
  el.style.height = `${r.bottom - r.top + 2}px`;
}

/** A link being edited: where its URL is, and the field showing it. */
type LinkField = { file: string; link: Link; prefix: string; original: string; input: HTMLInputElement };

/** The address as people read it: unescaped, without "mailto:". */
function linkFields(target: Target, map: SourceMap): Omit<LinkField, "input">[] {
  const seen = new Set<string>();
  const out: Omit<LinkField, "input">[] = [];
  for (const w of target.words) {
    const source = map.at(w);
    if (!source?.link || seen.has(`${source.file}:${source.link.from}`)) continue;
    seen.add(`${source.file}:${source.link.from}`);
    const raw = map.files.get(source.file)!.text.slice(source.link.from, source.link.to).replace(/\\([%#&_])/g, "$1");
    const prefix = raw.startsWith("mailto:") ? "mailto:" : "";
    out.push({ file: source.file, link: source.link, prefix, original: raw.slice(prefix.length) });
  }
  return out;
}

/** Open a text box over a component (and a field for each link in it). */
function openTarget(target: Target, el: HTMLElement, words: Word[], map: SourceMap) {
  const layer = el.parentElement!;
  if (layer.querySelector(".edit-input")) return;
  const original = target.words.map((w) => words[w]!.key);
  const box: Rect = {
    left: Math.min(...target.lines.map((l) => l.left)),
    top: Math.min(...target.lines.map((l) => l.top)),
    right: Math.max(...target.lines.map((l) => l.right)),
    bottom: Math.max(...target.lines.map((l) => l.bottom)),
  };
  const lineHeight = (box.bottom - box.top) / target.lines.length;
  const input = document.createElement("textarea");
  input.className = "edit-input";
  input.value = original.join(" ");
  input.spellcheck = true;
  input.rows = target.lines.length;
  // A little room to type past the end of a one-line component; the page reflows after the edit anyway.
  const room = target.lines.length === 1 ? Math.max(0, Math.min(120, target.page.viewport.width - box.right - 8)) : 0;
  place(input, box, room);
  input.style.fontSize = `${Math.min(lineHeight, target.lines[0]!.bottom - target.lines[0]!.top) * 0.86}px`; // a line box is ~1.1× the type size
  input.style.lineHeight = `${lineHeight}px`;
  el.hidden = true;
  layer.append(input);

  // Links: one field each, just under the text box.
  const fields: LinkField[] = [];
  let panel: HTMLElement | null = null;
  const found = linkFields(target, map);
  if (found.length) {
    panel = document.createElement("div");
    panel.className = "edit-links";
    panel.style.left = `${box.left - 2}px`;
    panel.style.top = `${box.bottom + 6}px`;
    for (const f of found) {
      const row = document.createElement("label");
      row.className = "edit-link";
      const name = document.createElement("span");
      name.textContent = f.prefix ? "Email" : "Link";
      const field = document.createElement("input");
      field.value = f.original;
      field.spellcheck = false;
      row.append(name, field);
      panel.append(row);
      fields.push({ ...f, input: field });
    }
    layer.append(panel);
    // Keep it on the page: a component near the right edge gets its fields shifted left.
    const maxLeft = target.page.viewport.width - panel.offsetWidth - 4;
    panel.style.left = `${Math.max(4, Math.min(box.left - 2, maxLeft))}px`;
  }
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  let done = false;
  const close = () => {
    input.remove();
    panel?.remove();
    el.hidden = false;
  };
  const finish = async (commit: boolean) => {
    if (done) return;
    done = true;
    const next = input.value.trim().split(/\s+/).filter(Boolean);
    const relinked = fields.filter((f) => f.input.value.trim() !== f.original);
    if (!commit || (next.join(" ") === original.join(" ") && !relinked.length)) return close();
    for (const el of [input, ...fields.map((f) => f.input)]) el.readOnly = true;
    input.classList.add("pending"); // stays on the page until the rebuilt PDF replaces it
    panel?.classList.add("pending");
    const problem = await writeEdit(target.words, original, next, map, relinked);
    if (problem) {
      toast(problem);
      close();
    }
  };
  // Done when focus leaves the text box and its link fields; Enter in any of them, Esc to cancel.
  const inside = (node: Node | null) => !!node && (node === input || !!panel?.contains(node));
  const onBlur = (e: FocusEvent) => {
    if (!inside(e.relatedTarget as Node | null)) void finish(true);
  };
  for (const f of fields) {
    f.input.onblur = onBlur;
    f.input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        void finish(false);
      }
    };
  }
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault(); // one component is one run of text: Enter means done
      void finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void finish(false);
    }
  };
  input.onblur = onBlur;
}

type Change = { from: number; to: number; insert: string };

/**
 * Work out the change word by word and write it into the source. `own` are the component's page
 * words (all mapped, in order), `before` their text, `after` what the box says now. Returns a problem
 * to show, or null.
 */
async function writeEdit(own: number[], before: string[], after: string[], map: SourceMap, relinked: LinkField[] = []): Promise<string | null> {
  const at = (k: number): SourceWord => map.at(own[k]!)!;
  const changes = new Map<string, Change[]>();
  const add = (file: string, change: Change) => changes.set(file, [...(changes.get(file) ?? []), change]);
  const acrossMarkup = "That change would cut through the document's formatting (a brace or a command). Edit inside one part, or use Source (e).";

  let k = 0; // position in `before`
  const parts = diffArrays(before, after);
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p]!;
    const n = part.count ?? part.value.length;
    if (!part.added && !part.removed) {
      k += n;
      continue;
    }
    // A hunk: removed words (maybe none) replaced by added words (maybe none).
    let removed = 0;
    let added: string[] = [];
    if (part.removed) {
      removed = n;
      const nextPart = parts[p + 1];
      if (nextPart?.added) {
        added = nextPart.value;
        p++;
      }
    } else added = part.value;

    if (removed) {
      const gone = Array.from({ length: removed }, (_, j) => at(k + j));
      const file = gone[0]!.file;
      if (gone.some((w) => w.file !== file || w.component !== gone[0]!.component)) return acrossMarkup;
      const text = map.files.get(file)!.text;
      if (added.length === removed) {
        // Same number of words: change each in place, so formatting between them stays where it is.
        gone.forEach((w, j) => add(file, { from: w.from, to: w.to, insert: escapeTyped(added[j]!) }));
      } else {
        // Otherwise the words go as one stretch, which must be plain text between them.
        for (let j = 1; j < gone.length; j++) if (/\S/.test(text.slice(gone[j - 1]!.to, gone[j]!.from).replace(/~/g, ""))) return acrossMarkup;
        const first = gone[0]!;
        const last = gone.at(-1)!;
        if (added.length) add(file, { from: first.from, to: last.to, insert: escapeTyped(added.join(" ")) });
        else {
          // Take a neighbouring space with the words, so no double space is left behind.
          const to = /\s/.test(text[last.to] ?? "") ? last.to + 1 : last.to;
          const from = to === last.to && /\s/.test(text[first.from - 1] ?? "") ? first.from - 1 : first.from;
          add(file, { from, to, insert: "" });
        }
      }
    } else {
      const prev = k > 0 ? at(k - 1) : null;
      const next = k < before.length ? at(k) : null;
      if (prev) add(prev.file, { from: prev.to, to: prev.to, insert: ` ${escapeTyped(added.join(" "))}` });
      else if (next) add(next.file, { from: next.from, to: next.from, insert: `${escapeTyped(added.join(" "))} ` });
    }
    k += removed;
  }

  // New addresses, written the way \href wants them (%, # and & escaped); never with braces or spaces.
  for (const f of relinked) {
    const address = f.input.value.trim();
    if (!address || /[\s{}\\]/.test(address)) return "A link can't be empty or contain spaces, braces or backslashes.";
    add(f.file, { from: f.link.from, to: f.link.to, insert: f.prefix + address.replace(/[%#&_]/g, (c) => `\\${c}`) });
  }

  // The last line of defence: never write a change that removes part of the document's structure.
  for (const [path, list] of changes) {
    const text = map.files.get(path)!.text;
    if (list.some((c) => breaksStructure(text.slice(c.from, c.to)))) return acrossMarkup;
  }

  for (const [path, list] of changes) {
    const base = map.files.get(path)!.text;
    const sorted = [...list].sort((a, b) => a.from - b.from);
    const result = editor.applyEdits(path, base, sorted as ChangeSpec[]);
    if (result === "applied") continue;
    if (result === "stale") return "The source changed since the page was drawn. Try again once it redraws.";
    let text = base;
    for (const c of [...sorted].reverse()) text = text.slice(0, c.from) + c.insert + text.slice(c.to);
    const res = await saveFile({ path, text, base: await sha256(base) });
    if ("conflict" in res) return "That file changed while you were editing (Claude?). Try again once the page redraws.";
    if ("error" in res) return `Couldn't save: ${res.error}`;
  }
  return null;
}

/** Whether removing `text` would unbalance braces or take out an environment or an item. */
export function breaksStructure(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth < 0) return true;
  }
  return depth !== 0 || /\\(begin|end|item)\b/.test(text);
}
