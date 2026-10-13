import { diffArrays, diffLines, diffWordsWithSpace } from "diff";

/**
 * The parts of the diff view that don't touch the DOM: turning PDF text into words
 * with positions, diffing two documents word by word, and diffing LaTeX source.
 */

// ---------- reader view: words as they appear on the page ----------

/** A run of text as pdf.js reports it, in PDF units (origin bottom-left, y = baseline). */
export type TextRun = { page: number; str: string; x: number; y: number; w: number; h: number; eol: boolean };

/**
 * Part of a word within one text run: characters [from, to) of `run.str`. x0/x1 are estimates
 * (characters share the run's width evenly); the view measures the real edges on the page.
 */
export type Box = { page: number; run: TextRun; from: number; to: number; x0: number; x1: number; y: number; h: number };

/** One word as a reader sees it. `key` is what gets compared; `boxes` is where it's drawn. */
export type Word = { key: string; boxes: Box[] };

/** A change: words [aFrom, aTo) of the old side were replaced by words [bFrom, bTo) of the new side. */
export type Change = { aFrom: number; aTo: number; bFrom: number; bTo: number };

type Char = { ch: string; run: TextRun | null; i: number };

/**
 * Rebuild words from text runs. pdf.js splits text at kerns and font changes, so a word can
 * span several runs; runs on one line are joined, with a space wherever there's a visible gap.
 */
export function wordsFrom(runs: TextRun[]): Word[] {
  const lines: Word[][] = [];
  let line: Char[] = [];
  const flush = () => {
    const words: Word[] = [];
    let word: Char[] = [];
    const end = () => {
      if (word.length) words.push({ key: word.map((c) => c.ch).join("").normalize("NFKC"), boxes: boxesOf(word) });
      word = [];
    };
    for (const c of line) /\s/.test(c.ch) ? end() : word.push(c);
    end();
    if (words.length) lines.push(words);
    line = [];
  };

  let prev: TextRun | null = null;
  for (const run of runs) {
    if (prev) {
      const newLine = prev.page !== run.page || prev.eol || Math.abs(run.y - prev.y) > Math.max(prev.h, run.h) * 0.5 || run.x < prev.x - 1;
      if (newLine) flush();
      else if (run.x - (prev.x + prev.w) > Math.min(prev.h, run.h) * 0.15) line.push({ ch: " ", run: null, i: 0 });
    }
    for (let i = 0; i < run.str.length; i++) line.push({ ch: run.str[i]!, run, i });
    prev = run;
  }
  flush();
  return dehyphenate(withoutPageNumbers(lines).flat());
}

const PAGE_NUMBER = /^(?:page\s+)?(?:\d+|[ivxlcdm]+)(?:\s*(?:of|\/)\s*\d+)?$/i;

/**
 * Drop page numbers (a page's top or bottom line when it's only a number, "Page 3", "3 of 12"…).
 * When text reflows, page breaks move and the numbers land elsewhere in the text, which
 * would otherwise show up as a scatter of one-word changes.
 */
function withoutPageNumbers(lines: Word[][]): Word[][] {
  const drop = new Set<Word[]>();
  const byPage = new Map<number, Word[][]>();
  for (const l of lines) {
    const page = l[0]!.boxes[0]!.page;
    byPage.set(page, [...(byPage.get(page) ?? []), l]);
  }
  for (const pageLines of byPage.values()) {
    const y = (l: Word[]) => l[0]!.boxes[0]!.y;
    const sorted = [...pageLines].sort((p, q) => y(p) - y(q));
    for (const edge of [sorted[0]!, sorted.at(-1)!]) {
      if (PAGE_NUMBER.test(edge.map((w) => w.key).join(" "))) drop.add(edge);
    }
  }
  return lines.filter((l) => !drop.has(l));
}

/** Boxes for a word's characters: one per text run it touches, sized by character share. */
function boxesOf(chars: Char[]): Box[] {
  const boxes: Box[] = [];
  let start = 0;
  for (let k = 1; k <= chars.length; k++) {
    if (k < chars.length && chars[k]!.run === chars[start]!.run) continue;
    const run = chars[start]!.run!;
    const per = run.w / Math.max(1, run.str.length);
    const from = chars[start]!.i;
    const to = chars[k - 1]!.i + 1;
    boxes.push({ page: run.page, run, from, to, x0: run.x + per * from, x1: run.x + per * to, y: run.y, h: run.h });
    start = k;
  }
  return boxes;
}

/** "exam-" at the end of a line followed by "ple" compares as "example", so reflowed paragraphs don't look rewritten. */
function dehyphenate(words: Word[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    const lastBox = w.boxes.at(-1)!;
    const lineEnd = next && (next.boxes[0]!.page !== lastBox.page || Math.abs(next.boxes[0]!.y - lastBox.y) > lastBox.h * 0.5);
    if (next && lineEnd && /\p{L}-$/u.test(w.key) && /^\p{Ll}/u.test(next.key)) {
      out.push({ key: w.key.slice(0, -1) + next.key, boxes: [...w.boxes, ...next.boxes] });
      i++;
    } else out.push(w);
  }
  return out;
}

/** Word-level diff of two documents. Returns null when they're too different to diff in reasonable time. */
export function diffWords(a: Word[], b: Word[]): Change[] | null {
  const parts = diffArrays(
    a.map((w) => w.key),
    b.map((w) => w.key),
    { timeout: 4000 },
  );
  if (!parts) return null;
  const changes: Change[] = [];
  let ia = 0;
  let ib = 0;
  let open: Change | null = null;
  for (const p of parts) {
    if (!p.added && !p.removed) {
      if (open) changes.push(open);
      open = null;
      ia += p.count;
      ib += p.count;
      continue;
    }
    open ??= { aFrom: ia, aTo: ia, bFrom: ib, bTo: ib };
    if (p.removed) open.aTo = ia += p.count;
    else open.bTo = ib += p.count;
  }
  if (open) changes.push(open);
  return changes;
}

// ---------- source view ----------

export type Segment = { text: string; changed: boolean };
export type SourceRow =
  | { kind: "same" | "del" | "add"; a?: number; b?: number; parts: Segment[] }
  | { kind: "fold"; count: number; rows: SourceRow[] };

/** Line diff with word-level highlights inside changed lines, unchanged stretches folded. */
export function diffSource(a: string, b: string, context = 3): { rows: SourceRow[]; changes: number } {
  const rows: SourceRow[] = [];
  let la = 1;
  let lb = 1;
  const parts = diffLines(a, b);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p.added && !p.removed) {
      for (const text of splitLines(p.value)) rows.push({ kind: "same", a: la++, b: lb++, parts: [{ text, changed: false }] });
      continue;
    }
    // A removed block followed by an added one is an edit: highlight the words that changed.
    const del = p.removed ? p.value : "";
    const addPart = p.removed && parts[i + 1]?.added ? parts[++i]! : p.added ? p : null;
    const add = addPart?.value ?? "";
    const [delLines, addLines] = wordLines(del, add);
    for (const segs of delLines) rows.push({ kind: "del", a: la++, parts: segs });
    for (const segs of addLines) rows.push({ kind: "add", b: lb++, parts: segs });
  }
  return { rows: fold(rows, context), changes: countHunks(rows) };
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop(); // the newline that ends the last line
  return lines;
}

/** Word diff of two blocks, split back into lines for each side. */
function wordLines(del: string, add: string): [Segment[][], Segment[][]] {
  if (!del || !add) {
    const whole = (s: string) => splitLines(s).map((text) => [{ text, changed: false }]);
    return [whole(del), whole(add)];
  }
  const delLines: Segment[][] = [[]];
  const addLines: Segment[][] = [[]];
  const push = (into: Segment[][], text: string, changed: boolean) => {
    text.split("\n").forEach((piece, k) => {
      if (k > 0) into.push([]);
      if (piece) into.at(-1)!.push({ text: piece, changed });
    });
  };
  for (const w of diffWordsWithSpace(del, add)) {
    if (!w.added) push(delLines, w.value, !!w.removed);
    if (!w.removed) push(addLines, w.value, !!w.added);
  }
  const trim = (lines: Segment[][]) => (lines.length > 1 && lines.at(-1)!.length === 0 ? lines.slice(0, -1) : lines);
  return [trim(delLines), trim(addLines)];
}

function countHunks(rows: SourceRow[]): number {
  let n = 0;
  let inHunk = false;
  for (const r of rows) {
    const changed = r.kind === "del" || r.kind === "add";
    if (changed && !inHunk) n++;
    inHunk = changed;
  }
  return n;
}

/** Keep `context` unchanged lines around each change; fold the rest. */
function fold(rows: SourceRow[], context: number): SourceRow[] {
  const near = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) near[k] = true;
  });
  const out: SourceRow[] = [];
  let hidden: SourceRow[] = [];
  const close = () => {
    if (hidden.length > 2) out.push({ kind: "fold", count: hidden.length, rows: hidden });
    else out.push(...hidden); // folding one or two lines saves nothing
    hidden = [];
  };
  rows.forEach((r, i) => {
    if (near[i]) {
      close();
      out.push(r);
    } else hidden.push(r);
  });
  close();
  return out;
}
