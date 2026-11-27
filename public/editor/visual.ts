import { EditorSelection, EditorState, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import katex from "katex";
import { scan, type Span } from "./latex-scan";

/**
 * The visual view: the same LaTeX source, shown as a document. Markup is hidden (not converted),
 * so typing here edits the real file and nothing is ever lost in a round trip:
 *   \section{Intro}   → a heading            \textbf{x}, \emph{x} → bold, italic
 *   $x^2$, \[…\]      → rendered math         \item               → a bullet or number
 *   \cite{k}, \ref{k} → a small chip          \includegraphics{f} → the image
 *   the preamble      → one "document settings" line (edit it in Source)
 * Where the cursor is, that piece shows its LaTeX so it can be edited, and renders again when you
 * leave. Anything the view doesn't know stays as written.
 */

export type VisualHooks = {
  /** A URL for an image the document includes, or null if it can't be found / shown. */
  imageUrl: (file: string) => string | null;
  /** Open an \include'd / \input file, or Source for the preamble. */
  openFile: (file: string) => void;
  showSource: (at: number) => void;
};

class TextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly cls: string,
    readonly onClick?: () => void,
  ) {
    super();
  }
  override eq(other: TextWidget) {
    return other.text === this.text && other.cls === this.cls;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.cls;
    el.textContent = this.text;
    if (this.onClick) {
      el.setAttribute("role", "button");
      el.onmousedown = (e) => {
        e.preventDefault();
        this.onClick!();
      };
    }
    return el;
  }
  override ignoreEvent() {
    return !!this.onClick;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  override eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "vm-math vm-display" : "vm-math";
    try {
      katex.render(this.tex, el, { displayMode: this.display, throwOnError: false, strict: "ignore" });
    } catch {
      el.textContent = this.tex;
    }
    return el;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly file: string,
  ) {
    super();
  }
  override eq(other: ImageWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const fig = document.createElement("div");
    fig.className = "vm-figure";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.file;
    fig.append(img);
    return fig;
  }
}

const hide = Decoration.replace({});
const lineClass = (cls: string) => Decoration.line({ class: cls });
const mark = (cls: string) => Decoration.mark({ class: cls });

/** Whether the view has focus: only then does the piece at the cursor show its LaTeX. */
const setFocused = StateEffect.define<boolean>();
const focusedField = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.find((e) => e.is(setFocused))?.value ?? value,
});

/** Whether the selection touches [from, to] while you're editing here: then that piece shows its LaTeX. */
function editing(state: EditorState, from: number, to: number) {
  return state.field(focusedField) && state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function build(state: EditorState, spans: Span[], hooks: VisualHooks): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  for (const s of spans) {
    if (s.type === "preamble") {
      if (s.to > s.from) {
        out.push(Decoration.replace({ widget: new TextWidget("Document settings · edit in Source", "vm-chip vm-preamble", () => hooks.showSource(0)), block: true }).range(s.from, s.to));
      }
      continue;
    }
    if (s.type === "comment") {
      out.push(mark("vm-comment").range(s.from, s.to));
      continue;
    }
    if (editing(state, s.from, s.to)) {
      if (s.type === "heading") out.push(lineClass(`vh vh-${s.level}`).range(doc.lineAt(s.from).from));
      out.push(mark("vm-raw").range(s.from, s.to));
      continue;
    }
    switch (s.type) {
      case "heading":
        out.push(lineClass(`vh vh-${s.level}`).range(doc.lineAt(s.from).from));
        out.push(hide.range(s.from, s.textFrom), hide.range(s.textTo, s.to));
        break;
      case "style":
        out.push(hide.range(s.from, s.textFrom), mark(`vs-${s.style}`).range(s.textFrom, s.textTo), hide.range(s.textTo, s.to));
        break;
      case "math": {
        const widget = new MathWidget(s.tex.trim(), s.display);
        // Display math on lines of its own becomes a block; anywhere else it stays inline.
        const first = doc.lineAt(s.from);
        const last = doc.lineAt(s.to);
        const ownLines = s.display && !doc.sliceString(first.from, s.from).trim() && !doc.sliceString(s.to, last.to).trim();
        out.push(Decoration.replace({ widget, block: ownLines }).range(ownLines ? first.from : s.from, ownLines ? last.to : s.to));
        break;
      }
      case "ref": {
        const text = s.kind === "cite" ? `[${s.key.replace(/\s*,\s*/g, ", ")}]` : s.kind === "ref" ? `→ ${s.key}` : `# ${s.key}`;
        out.push(Decoration.replace({ widget: new TextWidget(text, `vm-chip vm-${s.kind}`) }).range(s.from, s.to));
        break;
      }
      case "figure": {
        const src = hooks.imageUrl(s.file);
        const widget = src ? new ImageWidget(src, s.file) : new TextWidget(`Figure: ${s.file}`, "vm-chip");
        out.push(Decoration.replace({ widget }).range(s.from, s.to));
        break;
      }
      case "include":
        out.push(Decoration.replace({ widget: new TextWidget(`${s.file} ↗`, "vm-chip vm-include", () => hooks.openFile(s.file)) }).range(s.from, s.to));
        break;
      case "marker":
        out.push(Decoration.replace({ widget: new TextWidget(s.label, "vm-chip vm-marker") }).range(s.from, s.to));
        break;
      case "env": {
        // \begin{itemize} / \end{document} lines say nothing a reader needs: hide the whole line.
        const line = doc.lineAt(s.from);
        const ownLine = line.text.trim() === doc.sliceString(s.from, s.to).trim();
        const widget = s.label ? new TextWidget(s.label, "vm-env-label") : undefined;
        if (ownLine) out.push(Decoration.replace({ block: true, widget }).range(line.from, line.to));
        else out.push(Decoration.replace({ widget }).range(s.from, s.to));
        break;
      }
      case "item":
        out.push(lineClass("vm-item").range(doc.lineAt(s.from).from), Decoration.replace({ widget: new TextWidget(s.bullet, "vm-bullet") }).range(s.from, s.to));
        break;
      case "escape":
        out.push(Decoration.replace({ widget: new TextWidget(s.char, "") }).range(s.from, s.to));
        break;
      case "word":
        out.push(s.text ? Decoration.replace({ widget: new TextWidget(s.text, "") }).range(s.from, s.to) : hide.range(s.from, s.to));
        break;
    }
  }
  return Decoration.set(out, true);
}

/** Inside math (or a piece showing its LaTeX), typed characters are LaTeX; in prose they're text. */
function inRaw(spans: Span[], pos: number) {
  return spans.some((s) => {
    if (!(s.from < pos && pos < s.to)) return false;
    // A heading's or a style's text is prose; its command (\section{, \textbf{) and everything else is LaTeX.
    if (s.type === "heading" || s.type === "style") return pos <= s.textFrom || pos > s.textTo;
    return s.type !== "item" && s.type !== "escape" && s.type !== "word";
  });
}

/** Characters that mean something in LaTeX, written so they appear as typed. */
const ESCAPE_TYPED: Record<string, string> = { "%": "\\%", "&": "\\&", "#": "\\#", _: "\\_", $: "\\$" };

// ---------- formatting commands ----------

export function wrap(view: EditorView, command: string): boolean {
  const changes = view.state.changeByRange((r) => {
    const inner = view.state.sliceDoc(r.from, r.to);
    const insert = `\\${command}{${inner}}`;
    const start = r.from + command.length + 2;
    return { changes: { from: r.from, to: r.to, insert }, range: r.empty ? EditorSelection.cursor(start) : EditorSelection.range(start, start + inner.length) };
  });
  view.dispatch(changes, { userEvent: "input.format", scrollIntoView: true });
  view.focus();
  return true;
}

export function wrapMath(view: EditorView): boolean {
  const changes = view.state.changeByRange((r) => {
    const inner = view.state.sliceDoc(r.from, r.to);
    return { changes: { from: r.from, to: r.to, insert: `$${inner}$` }, range: EditorSelection.cursor(r.from + 1 + inner.length) };
  });
  view.dispatch(changes, { userEvent: "input.format" });
  view.focus();
  return true;
}

/** Make the cursor's line a heading of `command` (\section, \subsection…), or plain text again with "". */
export function setHeading(view: EditorView, command: string): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const text = line.text.replace(/^\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\{(.*)\}\s*$/, "$1");
  const insert = command ? `\\${command}{${text}}` : text;
  view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length - (command ? 1 : 0) }, userEvent: "input.format" });
  view.focus();
  return true;
}

export function insertList(view: EditorView, numbered = false): boolean {
  const env = numbered ? "enumerate" : "itemize";
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const atStart = line.text.trim() === "";
  const insert = `${atStart ? "" : "\n"}\\begin{${env}}\n  \\item \n\\end{${env}}\n`;
  const from = atStart ? line.from : line.to;
  view.dispatch({ changes: { from, to: atStart ? line.to : line.to, insert }, selection: { anchor: from + insert.indexOf("\\item ") + 6 }, userEvent: "input.format" });
  view.focus();
  return true;
}

export function insertCite(view: EditorView): boolean {
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, insert: "\\cite{}" }, selection: { anchor: pos + 6 }, userEvent: "input.format" });
  view.focus();
  return true;
}

/** Enter: a new list item inside a list, a new paragraph (a blank line) in prose. */
function enter(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  if (!r.empty) return false;
  const line = state.doc.lineAt(r.head);
  const item = /^(\s*)\\item\b/.exec(line.text);
  if (item) {
    // An empty item + Enter leaves the list.
    if (/^\s*\\item\s*$/.test(line.text)) return false;
    const insert = `\n${item[1]}\\item `;
    view.dispatch({ changes: { from: r.head, insert }, selection: { anchor: r.head + insert.length }, userEvent: "input" });
    return true;
  }
  const spans = view.state.field(spansField);
  if (inRaw(spans, r.head)) return false;
  view.dispatch({ changes: { from: r.head, insert: "\n\n" }, selection: { anchor: r.head + 2 }, userEvent: "input" });
  return true;
}

const spansField = StateField.define<Span[]>({
  create: (state) => scan(state.doc.toString()),
  update: (spans, tr) => (tr.docChanged ? scan(tr.state.doc.toString()) : spans),
});

/**
 * Text the visual view hides entirely (the preamble, \begin{…}/\end{…} lines), including the line breaks
 * around it. Typing or deleting can't reach it from here: a stray Backspace would otherwise join a list
 * item onto an invisible \begin{itemize}. It stays editable in Source.
 */
function hiddenRanges(state: EditorState, spans: Span[]): [number, number][] {
  const out: [number, number][] = [];
  for (const s of spans) {
    if (s.type === "preamble") out.push([0, s.to + 1]);
    if (s.type === "env") {
      const line = state.doc.lineAt(s.from);
      if (line.text.trim() === state.doc.sliceString(s.from, s.to).trim()) out.push([Math.max(0, line.from - 1), line.to + 1]);
    }
  }
  return out;
}

const protectHidden = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent("input") || tr.isUserEvent("delete")) || tr.isUserEvent("input.format")) return tr;
  const hidden = hiddenRanges(tr.startState, tr.startState.field(spansField));
  let touches = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    // Deleting across hidden text, or inserting inside it (the document's very start counts: nothing is
    // before the preamble). Typing at the end of the line before a hidden line, or right after it, is fine.
    if (hidden.some(([from, to]) => (toA > fromA ? fromA < to && toA > from : (fromA > from || from === 0) && fromA < to - 1))) touches = true;
  });
  return touches ? [] : tr;
});

export function visualExtensions(hooks: VisualHooks): Extension[] {
  const decorations = StateField.define<DecorationSet>({
    create: (state) => build(state, state.field(spansField), hooks),
    update: (deco, tr) =>
      tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setFocused)) ? build(tr.state, tr.state.field(spansField), hooks) : deco,
    provide: (f) => EditorView.decorations.from(f),
  });
  return [
    spansField,
    protectHidden,
    focusedField,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
    decorations,
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: "true", "aria-label": "Document (visual)" }),
    keymap.of([
      { key: "Enter", run: enter },
      { key: "Mod-b", run: (v) => wrap(v, "textbf") },
      { key: "Mod-i", run: (v) => wrap(v, "emph") },
      { key: "Mod-u", run: (v) => wrap(v, "underline") },
      { key: "Mod-m", run: wrapMath },
    ]),
    EditorView.inputHandler.of((view, from, to, text) => {
      // Typed text arrives a character at a time, or a word at once (IMEs, autocorrect): escape each special
      // character. Only plain insertions at the cursor: anything bigger is the browser reconciling the page.
      if (from !== to || text.includes("\n") || !/[%&#_$]/.test(text) || inRaw(view.state.field(spansField), from)) return false;
      const escaped = text.replace(/[%&#_$]/g, (c) => ESCAPE_TYPED[c]!);
      view.dispatch({ changes: { from, to, insert: escaped }, selection: { anchor: from + escaped.length }, userEvent: "input.type" });
      return true;
    }),
  ];
}

/** Where the document's text starts (just after \begin{document}), for the visual view's first cursor. */
export function bodyStart(text: string): number {
  const m = /^[^%\n]*\\begin\{document\}[^\n]*\n?/m.exec(text);
  return m ? m.index + m[0].length : 0;
}
