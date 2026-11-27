import { Annotation, EditorState, Transaction, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { $, toast } from "../core/util";
import { API, url, type SaveFileRequest, type SaveFileResponse } from "../../shared/protocol";
import type { FileNode } from "../../shared/types";
import { bodyStart, insertCite, insertList, setHeading, visualExtensions, wrap, wrapMath, type VisualHooks } from "./visual";

/**
 * One open text file, shown in up to two views of the same text:
 *   raw     the LaTeX as written (Source, in the middle column; for .bib/.md files, the preview)
 *   visual  the LaTeX shown as a document (the preview's Visual tab; LaTeX files only)
 * Typing in either updates the other at once (transactions are forwarded), and the undo history
 * lives in the raw view, so ⌘Z behaves the same in both.
 *
 * Saving is automatic, a moment after typing stops (⌘S saves at once), through /api/file/save;
 * the server's watcher then rebuilds the document and records a "You edited" version.
 * Every save names the version it started from, and the server refuses it if the file moved on
 * (Claude edited it). When the file changes on disk:
 *   no unsaved edits → the views quietly take the new version
 *   unsaved edits    → a bar asks: use the version on disk, or keep yours (overwrite it)
 */

const SAVE_IDLE_MS = 700;
const fromOtherView = Annotation.define<boolean>();

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

const latexHighlight = HighlightStyle.define([
  { tag: t.tagName, color: "var(--syn-command)" },
  { tag: t.atom, color: "var(--syn-env)" },
  { tag: [t.keyword, t.number], color: "var(--syn-math)" },
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: t.bracket, color: "var(--syn-brace)" },
  { tag: t.invalid, color: "var(--error)" },
]);

// Colors come from the theme tokens, so both views follow light and dark mode with the rest of the app.
const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--ink)", backgroundColor: "var(--panel)", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--leaf)", padding: "10px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--leaf)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--editor-selection)" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--faint)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--leaf-soft)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  ".cm-matchingBracket": { backgroundColor: "var(--leaf-soft)", outline: "1px solid var(--line-strong)" },
  ".cm-selectionMatch": { backgroundColor: "var(--sunken)" },
  ".cm-panels": { backgroundColor: "var(--chrome)", color: "var(--ink)", borderColor: "var(--line)" },
  "&.cm-focused": { outline: "none" },
});

export const isLatex = (file: FileNode | null) => !!file && (file.kind === "doc" || file.kind === "tex");

type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "error";

class SourceEditor {
  private raw: EditorView | null = null;
  private visual: EditorView | null = null;
  private file: FileNode | null = null;
  /** The text and hash of the version on disk that the editor last loaded or saved. */
  private savedText = "";
  private savedHash = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private conflict: { text: string; hash: string } | null = null;
  private openToken = 0;
  hooks: VisualHooks = { imageUrl: () => null, openFile: () => {}, showSource: () => {} };

  /** The tree path of the file being edited, or null. */
  get path() {
    return this.file?.path ?? null;
  }

  get dirty() {
    return !!this.raw && this.raw.state.doc.toString() !== this.savedText;
  }

  /** Typing is going into one of the views (on screen: a hidden view can keep focus for a moment). */
  hasFocus() {
    return [this.raw, this.visual].some((v) => !!v?.hasFocus && v.dom.offsetParent !== null);
  }

  focus(which: "raw" | "visual" = "raw", at?: number) {
    const view = which === "raw" ? this.raw : this.visual;
    if (!view) return;
    if (at !== undefined) view.dispatch({ selection: { anchor: Math.min(at, view.state.doc.length) }, scrollIntoView: true });
    view.focus();
  }

  /** Load a file (saving the previous one first if it has edits). LaTeX files get the visual view too. */
  async open(file: FileNode) {
    if (this.file?.path === file.path && this.raw) return;
    await this.flush();
    const token = ++this.openToken;
    const text = await (await fetch(url(API.file, { path: file.path, v: file.mtime }))).text();
    if (token !== this.openToken) return; // opened something else meanwhile
    this.file = file;
    this.savedText = text;
    this.savedHash = await sha256(text);
    this.conflict = null;
    this.showConflictBars(false);

    const rawState = EditorState.create({ doc: text, extensions: this.rawExtensions(file) });
    if (this.raw) this.raw.setState(rawState);
    else this.raw = new EditorView({ state: rawState, dispatchTransactions: (trs) => this.forward(trs, this.raw!, this.visual) });
    // The raw view lives in Source for LaTeX files, and fills the preview for other text files.
    const host = isLatex(file) ? $("source") : $("editor");
    if (this.raw.dom.parentElement !== host) host.append(this.raw.dom);

    if (isLatex(file)) {
      const visualState = EditorState.create({ doc: text, selection: { anchor: bodyStart(text) }, extensions: this.visualExtensions() });
      if (this.visual) this.visual.setState(visualState);
      else this.visual = new EditorView({ state: visualState, parent: $("visual"), dispatchTransactions: (trs) => this.forward(trs, this.visual!, this.raw) });
    }
    this.show("saved");
  }

  /** Stop editing (another kind of file opened). Unsaved edits are saved first. */
  async close() {
    await this.flush();
    this.openToken++;
    this.file = null;
  }

  /** Save now if there's anything unsaved (⌘S, switching files, leaving the page). */
  async flush() {
    clearTimeout(this.timer);
    if (this.saving) await this.saving;
    if (this.dirty && !this.conflict) await this.save();
  }

  /**
   * The file changed on disk (the tree reported a new mtime). If it's our own save, nothing to do;
   * otherwise take the new version, or ask if there are unsaved edits.
   */
  async changedOnDisk(file: FileNode) {
    if (file.path !== this.file?.path) return;
    if (this.saving) await this.saving;
    const text = await (await fetch(url(API.file, { path: file.path, v: file.mtime }))).text();
    const hash = await sha256(text);
    if (hash === this.savedHash || file.path !== this.file?.path) return;
    if (this.dirty) return this.showConflict(text, hash);
    this.replaceWith(text, hash);
  }

  /**
   * Apply a view's transactions, and pass its edits on to the other view. The other view must be on
   * the same text for the edit's positions to mean the same thing; if it ever isn't (a file swapped in
   * underneath), it's brought back in line first, never patched at the wrong place.
   */
  private forward(trs: readonly Transaction[], view: EditorView, other: EditorView | null) {
    view.update(trs);
    if (!other || !this.file || !isLatex(this.file)) return;
    for (const tr of trs) {
      if (tr.changes.empty || tr.annotation(fromOtherView)) continue;
      const userEvent = tr.annotation(Transaction.userEvent);
      const annotations = [fromOtherView.of(true), ...(userEvent ? [Transaction.userEvent.of(userEvent)] : [])];
      if (other.state.doc.eq(tr.startState.doc)) other.dispatch({ changes: tr.changes, annotations });
      else other.dispatch({ changes: { from: 0, to: other.state.doc.length, insert: tr.state.doc }, annotations });
    }
  }

  private rawExtensions(file: FileNode): Extension[] {
    const isTex = isLatex(file) || /\.(sty|cls)$/i.test(file.name);
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      EditorView.lineWrapping, // LaTeX is mostly prose: wrap long paragraphs instead of scrolling sideways
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      isTex ? StreamLanguage.define(stex) : [],
      syntaxHighlighting(latexHighlight),
      theme,
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        this.show(this.dirty ? "unsaved" : "saved");
        clearTimeout(this.timer);
        if (this.dirty && !this.conflict) this.timer = setTimeout(() => void this.save(), SAVE_IDLE_MS);
      }),
    ];
  }

  private visualExtensions(): Extension[] {
    // Undo and redo go to the raw view's history, which records edits from both views.
    const history = (run: typeof undo) => () => (this.raw ? run(this.raw) : false);
    return [
      keymap.of([
        { key: "Mod-z", run: history(undo), preventDefault: true },
        { key: "Mod-Shift-z", run: history(redo), preventDefault: true },
        { key: "Mod-y", run: history(redo), preventDefault: true },
      ]),
      visualExtensions(this.hooks),
      drawSelection(),
      keymap.of([...defaultKeymap, ...searchKeymap]),
      StreamLanguage.define(stex), // LaTeX the view shows as written still gets its colors
      syntaxHighlighting(latexHighlight),
      theme,
    ];
  }

  /** Write the editor's text, unless the file changed on disk since our version (`force` overwrites it). */
  private save(force = false): Promise<void> {
    const run = async () => {
      if (!this.raw || !this.file) return;
      const text = this.raw.state.doc.toString();
      const path = this.file.path;
      this.show("saving");
      const body: SaveFileRequest = { path, text, base: force ? null : this.savedHash };
      const res = (await fetch(API.fileSave, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then((r) => r.json())
        .catch(() => ({ error: "Couldn't reach underleaf" }))) as SaveFileResponse;
      if (path !== this.file?.path) return;
      if ("conflict" in res) return this.showConflict(res.text, res.hash);
      if ("error" in res) {
        this.show("error");
        toast(`Couldn't save ${this.file.name}: ${res.error}`);
        return;
      }
      this.savedText = text;
      this.savedHash = res.hash;
      this.show(this.dirty ? "unsaved" : "saved"); // you may have kept typing while it saved
      if (this.dirty) this.timer = setTimeout(() => void this.save(), SAVE_IDLE_MS);
    };
    const saving = run().finally(() => {
      if (this.saving === saving) this.saving = null;
    });
    this.saving = saving;
    return saving;
  }

  private showConflict(text: string, hash: string) {
    clearTimeout(this.timer);
    this.conflict = { text, hash };
    this.showConflictBars(true);
    this.show("conflict");
  }

  private showConflictBars(visible: boolean) {
    for (const bar of document.querySelectorAll<HTMLElement>(".editor-conflict")) bar.hidden = !visible;
  }

  /** "Use the version on disk": drop the unsaved edits. */
  takeTheirs() {
    if (!this.conflict) return;
    this.replaceWith(this.conflict.text, this.conflict.hash);
  }

  /** "Keep mine": overwrite the file on disk with the editor's text. */
  keepMine() {
    if (!this.conflict) return;
    this.conflict = null;
    this.showConflictBars(false);
    void this.save(true);
  }

  /** Swap in another version of the file (both views follow), keeping the cursor and scroll position where they can be. */
  private replaceWith(text: string, hash: string) {
    if (!this.raw) return;
    this.conflict = null;
    this.showConflictBars(false);
    this.savedText = text;
    this.savedHash = hash;
    const head = Math.min(this.raw.state.selection.main.head, text.length);
    const top = this.raw.scrollDOM.scrollTop;
    this.raw.dispatch({ changes: { from: 0, to: this.raw.state.doc.length, insert: text }, selection: { anchor: head } });
    this.raw.scrollDOM.scrollTop = top;
    // The visual cursor can't sit in the preamble (it's folded away): put it where the text starts.
    const start = bodyStart(text);
    if (this.visual && this.visual.state.selection.main.head < start) this.visual.dispatch({ selection: { anchor: start } });
    this.show("saved");
  }

  private show(state: SaveState) {
    const text = { saved: "Saved", unsaved: "Edited", saving: "Saving…", conflict: "Changed on disk", error: "Not saved" }[state];
    for (const el of document.querySelectorAll<HTMLElement>(".editor-state")) {
      el.dataset.state = state;
      el.textContent = text;
    }
  }

  // ---------- the visual view's formatting toolbar ----------

  format(action: string) {
    const v = this.visual;
    if (!v) return;
    const actions: Record<string, () => boolean> = {
      bold: () => wrap(v, "textbf"),
      italic: () => wrap(v, "emph"),
      section: () => setHeading(v, "section"),
      subsection: () => setHeading(v, "subsection"),
      text: () => setHeading(v, ""),
      list: () => insertList(v),
      numbered: () => insertList(v, true),
      math: () => wrapMath(v),
      cite: () => insertCite(v),
    };
    actions[action]?.();
  }
}

export const editor = new SourceEditor();

export function initEditor() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-editor-action]")) {
    b.onclick = () => (b.dataset.editorAction === "take-theirs" ? editor.takeTheirs() : editor.keepMine());
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-format]")) {
    b.onmousedown = (e) => e.preventDefault(); // keep the selection in the document
    b.onclick = () => editor.format(b.dataset.format!);
  }
  // Leaving or reloading the page: try to save what's unsaved (and warn if a save can't finish).
  window.addEventListener("beforeunload", (e) => {
    if (!editor.dirty) return;
    void editor.flush();
    e.preventDefault();
  });
}
