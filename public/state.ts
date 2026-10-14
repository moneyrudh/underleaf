import type { FileNode } from "../src/workspace";
import { $, storage } from "./util";

/** What's open and what the server has told us, shared by the modules that make up the app. */
export const state = {
  selected: null as FileNode | null,
  /** Whether the server keeps version history (it needs git). */
  historyEnabled: false,
  /** Latest good PDF of the open document. */
  lastPdf: null as string | null,
  /** Tree root keys ("latex", "resumes") → absolute folders. */
  roots: {} as Record<string, string>,
  /** Recently opened paths, most recent first (quick-open ranks by this). */
  recent: JSON.parse(storage("recent") ?? "[]") as string[],
};

/** The preview toolbar's document actions. */
export const ui = {
  title: $("preview-title"),
  exportButton: $<HTMLButtonElement>("export"),
  download: $<HTMLAnchorElement>("download"),
  zoom: $("zoom"),
};

/** Earlier versions and comparisons can't be saved or zoomed: hide those actions meanwhile. */
export function hideDocumentActions() {
  ui.exportButton.hidden = ui.download.hidden = ui.zoom.hidden = true;
}
