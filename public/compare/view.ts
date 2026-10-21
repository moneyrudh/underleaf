import * as pdfjs from "pdfjs-dist";
import { diffSource, diffWords, wordsFrom, type Box, type Change, type SourceRow, type TextRun, type Word } from "./diffcore";
import { renderPage, setStatus } from "../preview/preview";
import { PageInk, type Rect } from "./ink";
import { $ } from "../core/util";
import { toggleMenu, type MenuItem } from "../ui/menu";
import { API, url } from "../../shared/protocol";

/** One side of a comparison: a file as it is now, or as it was at a snapshot. */
export type Side = {
  path: string; // tree path of the file now ("latex/…")
  label: string;
  commit?: string; // a snapshot, or undefined for the live file
  snapPath?: string; // the file's workspace-relative path at that snapshot
  pdf?: string | null; // live documents: the latest good PDF
  doc: boolean; // compiles to a PDF (otherwise only the source can be compared)
};

export type Mode = "reader" | "source";
export type SideOption = MenuItem;

type Handlers = {
  onPick: (which: "a" | "b", value: string) => void;
  onClose: () => void;
};

type Loaded = { pdf: pdfjs.PDFDocumentProxy | null; task?: pdfjs.PDFDocumentLoadingTask; error?: string; words: Word[] };

const GAP = 12; // px between the two columns

/**
 * Compare two versions of a document: "what the reader sees" (both PDFs side by side,
 * removed words red on the left, added words green on the right) or the LaTeX source.
 */
export class DiffView {
  private bar = $("compare-bar");
  private el = $("diff");
  private viewer = $("viewer");
  private col = this.viewer.parentElement!;
  private selA = $<HTMLButtonElement>("compare-a");
  private selB = $<HTMLButtonElement>("compare-b");
  private options: SideOption[] = [];
  private picked: [string, string] = ["", ""];
  private names = $("compare-names");
  private readerButton = $<HTMLButtonElement>("compare-reader");
  private sourceButton = $<HTMLButtonElement>("compare-source");
  private token = 0;
  private loaded: [Loaded, Loaded] | null = null;
  private changes: Change[] = [];
  private at = -1;
  private renderedWidth = 0;
  a: Side | null = null;
  b: Side | null = null;
  mode: Mode = "reader";
  private preferred: Mode = "reader"; // what you last picked; files without a PDF show source regardless

  constructor(private handlers: Handlers) {
    this.selA.onclick = () => toggleMenu(this.selA, this.options, this.picked[0], (v) => handlers.onPick("a", v));
    this.selB.onclick = () => toggleMenu(this.selB, this.options, this.picked[1], (v) => handlers.onPick("b", v));
    this.readerButton.onclick = () => this.setMode("reader");
    this.sourceButton.onclick = () => this.setMode("source");
    $("compare-prev").onclick = () => this.step(-1);
    $("compare-next").onclick = () => this.step(1);
    $("compare-close").onclick = () => handlers.onClose();
    let timer: ReturnType<typeof setTimeout>;
    new ResizeObserver(() => {
      if (!this.active || this.mode !== "reader" || this.el.clientWidth === this.renderedWidth) return;
      clearTimeout(timer);
      timer = setTimeout(() => this.render(), 150);
    }).observe(this.el);
  }

  get active() {
    return !this.bar.hidden;
  }

  /** Show a comparison. `options` fills the two version pickers (omit them to show file names instead). */
  async show(a: Side, b: Side, options?: SideOption[], picked?: [string, string]) {
    const fresh = !this.active || a.path !== this.a?.path || b.path !== this.b?.path;
    this.a = a;
    this.b = b;
    this.mode = a.doc && b.doc ? this.preferred : "source";
    this.bar.hidden = false;
    this.col.classList.add("comparing");
    this.viewer.hidden = true;
    this.el.hidden = false;
    this.readerButton.disabled = !a.doc || !b.doc;
    this.readerButton.title = this.readerButton.disabled ? "Only documents that compile have a reader view" : "What the reader sees (PDF)";
    this.updateModeButtons();

    this.selA.hidden = this.selB.hidden = !options;
    this.names.hidden = !!options;
    if (options && picked) {
      this.options = options;
      this.picked = picked;
      for (const [button, value] of [[this.selA, picked[0]], [this.selB, picked[1]]] as const) {
        const option = options.find((o) => o.value === value);
        const icon = document.createElement("span");
        icon.className = `icon ${option?.kind ? `kind-${option.kind}` : ""}`;
        icon.textContent = option?.icon ?? "";
        const label = document.createElement("span");
        label.className = "picker-label";
        label.textContent = option?.label ?? "";
        const chevron = document.createElement("span");
        chevron.className = "chevron";
        chevron.textContent = "▾";
        button.replaceChildren(icon, label, chevron);
        button.dataset.tip = option ? `${option.label}${option.meta ? ` · ${option.meta}` : ""}` : "";
      }
    } else {
      this.names.textContent = `${a.label}  →  ${b.label}`;
    }
    if (fresh) this.el.scrollTop = 0;
    await this.load();
  }

  /** The live document recompiled: refresh whichever side shows it. */
  livePdf(path: string, pdf: string | null) {
    let hit = false;
    for (const side of [this.a, this.b]) {
      if (side && !side.commit && side.path === path && side.pdf !== pdf) {
        side.pdf = pdf;
        hit = true;
      }
    }
    if (hit) this.load();
  }

  /** The live file changed on disk (source view of a non-document). */
  liveFile(path: string) {
    if (this.mode === "source" && [this.a, this.b].some((s) => s && !s.commit && s.path === path)) this.load();
  }

  close() {
    if (!this.active) return;
    this.token++;
    this.bar.hidden = true;
    this.el.hidden = true;
    this.viewer.hidden = false;
    this.col.classList.remove("comparing");
    this.el.replaceChildren();
    this.destroy();
    this.a = this.b = null;
  }

  setMode(mode: Mode) {
    if (mode === this.mode || (mode === "reader" && this.readerButton.disabled)) return;
    this.mode = this.preferred = mode;
    this.updateModeButtons();
    this.el.scrollTop = 0;
    this.load();
  }

  toggleMode() {
    this.setMode(this.mode === "reader" ? "source" : "reader");
  }

  get scroller() {
    return this.el;
  }

  /** ]c / [c: jump to the next or previous change. */
  step(dir: 1 | -1) {
    const marks = this.el.querySelectorAll<HTMLElement>("[data-change]");
    const count = this.mode === "reader" ? this.changes.length : new Set([...marks].map((m) => m.dataset.change)).size;
    if (count === 0) return;
    this.at = this.at < 0 ? (dir > 0 ? 0 : count - 1) : (this.at + dir + count) % count;
    const hits = this.el.querySelectorAll<HTMLElement>(`[data-change="${this.at}"]`);
    this.el.querySelectorAll(".current").forEach((e) => e.classList.remove("current"));
    hits.forEach((e) => e.classList.add("current"));
    // Scroll so the change sits a third of the way down, where the eye expects it.
    const first = [...hits].sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top)[0];
    if (first) {
      const top = first.getBoundingClientRect().top - this.el.getBoundingClientRect().top + this.el.scrollTop;
      this.el.scrollTo({ top: Math.max(0, top - this.el.clientHeight / 3), behavior: "smooth" });
    }
    setStatus(`Change ${this.at + 1} of ${count}`, "info");
  }

  private updateModeButtons() {
    this.readerButton.classList.toggle("on", this.mode === "reader");
    this.sourceButton.classList.toggle("on", this.mode === "source");
  }

  private destroy() {
    for (const l of this.loaded ?? []) l.task?.destroy();
    this.loaded = null;
  }

  // ---------- loading ----------

  private async load() {
    const token = ++this.token;
    const [a, b] = [this.a!, this.b!];
    this.el.classList.add("loading");
    setStatus("Comparing…", "busy");
    if (this.mode === "source") return this.loadSource(token, a, b);

    const loaded = await Promise.all([loadPdf(a), loadPdf(b)]);
    if (token !== this.token) return void loaded.forEach((l) => l.task?.destroy());
    this.destroy();
    this.loaded = loaded;
    this.changes = (!loaded[0].error && !loaded[1].error && diffWords(loaded[0].words, loaded[1].words)) || [];
    await this.render();
  }

  private async loadSource(token: number, a: Side, b: Side) {
    const [ta, tb] = await Promise.all([loadText(a), loadText(b)]);
    if (token !== this.token) return;
    this.destroy();
    if (ta === null || tb === null) return this.swap(message(`Couldn't read ${ta === null ? a.label : b.label}.`));
    const { rows, changes } = diffSource(ta, tb);
    let added = 0;
    let removed = 0;
    const walk = (r: SourceRow) => (r.kind === "fold" ? r.rows.forEach(walk) : r.kind === "add" ? added++ : r.kind === "del" && removed++);
    rows.forEach(walk);
    this.swap(renderSource(rows, a, b));
    setStatus(changes ? plural(changes, "change") : "No changes", changes ? "info" : "ok", changes ? `${added} lines added, ${removed} removed` : "The LaTeX source is identical.");
  }

  // ---------- reader view ----------

  private async render() {
    if (!this.loaded || this.mode !== "reader") return;
    const token = this.token;
    const [la, lb] = this.loaded;
    if (la.error || lb.error) {
      const which = la.error ? this.a!.label : this.b!.label;
      const el = message(`${escape(which)}: ${escape((la.error ?? lb.error)!)}<br><button class="ghost" data-source>Compare the source instead</button>`);
      el.querySelector<HTMLButtonElement>("[data-source]")!.onclick = () => this.setMode("source");
      this.swap(el);
      return setStatus("Can't compare the PDFs", "fail");
    }

    this.renderedWidth = this.el.clientWidth;
    const columnWidth = Math.max(120, (this.el.clientWidth - 32 - GAP) / 2);
    const grid = document.createElement("div");
    grid.className = "diff-reader";
    grid.style.setProperty("--gap", `${GAP}px`);
    grid.append(head(this.a!, "before"), head(this.b!, "after"));

    // Pages side by side in one scroller, so both columns always scroll together.
    const pages = Math.max(la.pdf!.numPages, lb.pdf!.numPages);
    const cells: PageCell[][] = [[], []];
    for (let n = 1; n <= pages; n++) {
      for (const [k, l] of [la, lb].entries()) {
        const cell: PageCell = document.createElement("div");
        cell.className = "diff-page";
        if (n <= l.pdf!.numPages) {
          const page = await l.pdf!.getPage(n);
          const scale = columnWidth / page.getViewport({ scale: 1 }).width;
          const canvas = await renderPage(page, scale);
          cell.append(canvas);
          cell.ink = new PageInk(page, canvas, page.getViewport({ scale }));
        } else cell.classList.add("missing");
        if (token !== this.token) return;
        cells[k]![n] = cell;
        grid.append(cell);
      }
    }

    // Measure only the pages that get highlights.
    const pagesOf = (words: Word[], from: number, to: number) => words.slice(Math.max(0, from - 1), to + 1).flatMap((w) => w.boxes.map((b) => b.page));
    for (const [k, l] of [la, lb].entries()) {
      const pages = new Set(this.changes.flatMap((c) => (k === 0 ? pagesOf(l.words, c.aFrom, c.aTo) : pagesOf(l.words, c.bFrom, c.bTo))));
      for (const n of pages) await cells[k]![n]?.ink?.prepare();
      if (token !== this.token) return;
    }

    // Highlights: removed words on the left, added on the right. A pure insertion or
    // deletion also gets a caret on the other side, where the text went or came from.
    let added = 0;
    let removed = 0;
    this.changes.forEach((c, i) => {
      removed += c.aTo - c.aFrom;
      added += c.bTo - c.bFrom;
      for (let w = c.aFrom; w < c.aTo; w++) for (const box of la.words[w]!.boxes) mark(cells[0]!, box, "del", i);
      for (let w = c.bFrom; w < c.bTo; w++) for (const box of lb.words[w]!.boxes) mark(cells[1]!, box, "add", i);
      if (c.aFrom === c.aTo) caret(cells[0]!, la.words, c.aFrom, i, "add");
      if (c.bFrom === c.bTo) caret(cells[1]!, lb.words, c.bFrom, i, "del");
    });

    this.at = -1;
    this.swap(grid);
    const n = this.changes.length;
    setStatus(
      n ? plural(n, "change") : "Same text",
      n ? "info" : "ok",
      n ? `${added} words added, ${removed} removed` : "The text is identical. Any differences are in layout or styling.",
    );
  }

  private swap(content: HTMLElement) {
    const { scrollTop } = this.el;
    this.el.classList.remove("loading");
    this.el.replaceChildren(content);
    this.el.scrollTop = scrollTop;
    this.at = -1;
  }
}

// ---------- helpers ----------

async function loadPdf(side: Side): Promise<Loaded> {
  const source = side.commit ? url(API.historyPdf, { commit: side.commit, path: side.snapPath }) : (side.pdf ?? url(API.pdf, { doc: side.path }));
  const res = await fetch(source).catch(() => null);
  if (!res?.ok) {
    const error = res?.status === 422 ? "this version doesn't compile" : "it hasn't compiled yet";
    return { pdf: null, error, words: [] };
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()) });
  const pdf = await task.promise;
  const runs: TextRun[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    for (const item of content.items) {
      if (!("str" in item) || !item.str) continue;
      const [, , c, d, x, y] = item.transform as number[];
      runs.push({ page: n, str: item.str, x: x!, y: y!, w: item.width, h: item.height || Math.hypot(c!, d!), eol: item.hasEOL });
    }
  }
  return { pdf, task, words: wordsFrom(runs) };
}

async function loadText(side: Side): Promise<string | null> {
  const source = side.commit
    ? url(API.historyFile, { commit: side.commit, path: side.snapPath })
    : url(API.file, { path: side.path, t: Date.now() }); // never a cached copy of the live file
  const res = await fetch(source).catch(() => null);
  return res?.ok ? res.text() : null;
}

type PageCell = HTMLElement & { ink?: PageInk };
function place(cell: PageCell, r: Rect, kind: string, change: number) {
  const el = document.createElement("span");
  el.className = `hl ${kind}`;
  el.dataset.change = String(change);
  el.style.left = `${r.left - 1.5}px`;
  el.style.top = `${r.top - 1}px`;
  el.style.width = `${r.right - r.left + 3}px`;
  el.style.height = `${r.bottom - r.top + 2}px`;
  cell.append(el);
}

/** Highlight a word part where it really is on the page. */
function mark(cells: PageCell[], box: Box, kind: string, change: number) {
  const cell = cells[box.page];
  if (cell?.ink) place(cell, cell.ink.rect(box), kind, change);
}

/** A thin marker after word `at - 1` (or before word 0): text was added ("add") or removed ("del") here. */
function caret(cells: PageCell[], words: Word[], at: number, change: number, kind: "add" | "del") {
  const before = words[at - 1]?.boxes.at(-1);
  const after = words[at]?.boxes[0];
  const box = before ?? after;
  const cell = box && cells[box.page];
  if (!box || !cell?.ink) return;
  const r = cell.ink.rect(box);
  const x = before ? r.right + 2.5 : r.left - 4.5; // in the space beside the word, clear of its letters
  place(cell, { ...r, left: x, right: x }, `caret ${kind}`, change);
}

function head(side: Side, which: "before" | "after") {
  const el = document.createElement("div");
  el.className = `diff-head ${which}`;
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = which === "before" ? "Before" : "After";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = side.label; // labels can contain Claude prompts: text only
  el.append(tag, name);
  return el;
}

function renderSource(rows: SourceRow[], a: Side, b: Side): HTMLElement {
  const table = document.createElement("div");
  table.className = "diff-source";
  const top = document.createElement("div");
  top.className = "diff-source-head";
  top.append(head(a, "before"), head(b, "after"));
  table.append(top);

  let hunk = -1;
  let inHunk = false;
  const build = (list: SourceRow[], into: HTMLElement) => {
    for (const r of list) {
      if (r.kind === "fold") {
        const fold = document.createElement("button");
        fold.className = "src-fold";
        fold.textContent = `⋯ ${r.count} unchanged lines`;
        fold.onclick = () => {
          const frag = document.createElement("div");
          frag.className = "src-unfolded";
          build(r.rows, frag);
          fold.replaceWith(frag);
        };
        into.append(fold);
        inHunk = false;
        continue;
      }
      const changed = r.kind !== "same";
      if (changed && !inHunk) hunk++;
      inHunk = changed;
      const row = document.createElement("div");
      row.className = `src-row ${r.kind}`;
      if (changed) row.dataset.change = String(hunk);
      const na = document.createElement("span");
      na.className = "ln";
      na.textContent = r.a ? String(r.a) : "";
      const nb = document.createElement("span");
      nb.className = "ln";
      nb.textContent = r.b ? String(r.b) : "";
      const sign = document.createElement("span");
      sign.className = "sign";
      sign.textContent = r.kind === "add" ? "+" : r.kind === "del" ? "−" : "";
      const code = document.createElement("span");
      code.className = "code";
      for (const p of r.parts) {
        if (!p.changed) code.append(p.text);
        else {
          const w = document.createElement("mark");
          w.textContent = p.text;
          code.append(w);
        }
      }
      if (!code.textContent) code.append("​"); // keep empty lines one line tall
      row.append(na, nb, sign, code);
      into.append(row);
    }
  };
  build(rows, table);
  return table;
}

function message(html: string) {
  const p = document.createElement("p");
  p.className = "message";
  p.innerHTML = html;
  return p;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
