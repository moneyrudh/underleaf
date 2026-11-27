import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { $, toast } from "../core/util";
import { API, url, type SaveFileRequest, type SaveFileResponse } from "../../shared/protocol";
import type { FileNode } from "../../shared/types";

/**
 * The source editor: one CodeMirror view for the open text file (a .tex, .bib, .md, …).
 * Saving is automatic, a moment after you stop typing (⌘S saves at once), and goes through
 * /api/file/save; the server's watcher then rebuilds the document and records a "You edited"
 * version, exactly as when any other editor saves.
 *
 * Claude (or anything else) can change the same file. Every save says which version it started
 * from, and the server refuses it if the file moved on. When the file changes on disk:
 *   no unsaved edits → the editor quietly takes the new version (keeping your place)
 *   unsaved edits    → a bar asks: use the version on disk, or keep yours (overwrite it)
 */

const SAVE_IDLE_MS = 700;

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

// Colors come from the theme tokens, so the editor follows light and dark mode with the rest of the app.
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

type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "error";

class SourceEditor {
  private view: EditorView | null = null;
  private file: FileNode | null = null;
  /** The text and hash of the version on disk that the editor last loaded or saved. */
  private savedText = "";
  private savedHash = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private conflict: { text: string; hash: string } | null = null;
  private openToken = 0;

  /** The tree path of the file being edited, or null. */
  get path() {
    return this.file?.path ?? null;
  }

  get dirty() {
    return !!this.view && this.view.state.doc.toString() !== this.savedText;
  }

  hasFocus() {
    return !!this.view?.hasFocus;
  }

  focus() {
    this.view?.focus();
  }

  /** Load a file into the editor (saving the previous one first if it has edits). */
  async open(file: FileNode) {
    if (this.file?.path === file.path && this.view) return;
    await this.flush();
    const token = ++this.openToken;
    const text = await (await fetch(url(API.file, { path: file.path, v: file.mtime }))).text();
    if (token !== this.openToken) return; // opened something else meanwhile
    this.file = file;
    this.savedText = text;
    this.savedHash = await sha256(text);
    this.conflict = null;
    $("editor-conflict").hidden = true;
    const state = EditorState.create({ doc: text, extensions: this.extensions(file) });
    if (this.view) this.view.setState(state);
    else this.view = new EditorView({ state, parent: $("editor") });
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

  private extensions(file: FileNode): Extension[] {
    const isTex = file.kind === "doc" || file.kind === "tex" || /\.(sty|cls)$/i.test(file.name);
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
      keymap.of([
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
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

  /** Write the editor's text, unless the file changed on disk since our version (`force` overwrites it). */
  private save(force = false): Promise<void> {
    const run = async () => {
      if (!this.view || !this.file) return;
      const text = this.view.state.doc.toString();
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
    $("editor-conflict").hidden = false;
    this.show("conflict");
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
    $("editor-conflict").hidden = true;
    void this.save(true);
  }

  /** Swap in another version of the file, keeping the cursor and scroll position where they can be. */
  private replaceWith(text: string, hash: string) {
    if (!this.view) return;
    this.conflict = null;
    $("editor-conflict").hidden = true;
    this.savedText = text;
    this.savedHash = hash;
    const head = Math.min(this.view.state.selection.main.head, text.length);
    const top = this.view.scrollDOM.scrollTop;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text }, selection: { anchor: head } });
    this.view.scrollDOM.scrollTop = top;
    this.show("saved");
  }

  private show(state: SaveState) {
    const el = $("editor-state");
    el.dataset.state = state;
    el.textContent = { saved: "Saved", unsaved: "Edited", saving: "Saving…", conflict: "Changed on disk", error: "Not saved" }[state];
  }
}

export const editor = new SourceEditor();

export function initEditor() {
  $("editor-take-theirs").onclick = () => editor.takeTheirs();
  $("editor-keep-mine").onclick = () => editor.keepMine();
  // Leaving or reloading the page: try to save what's unsaved (and warn if a save can't finish).
  window.addEventListener("beforeunload", (e) => {
    if (!editor.dirty) return;
    void editor.flush();
    e.preventDefault();
  });
}
