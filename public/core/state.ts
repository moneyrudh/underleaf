import { $ } from "./util";
import type { WorkspaceMessage } from "../../shared/protocol";
import type { FileNode } from "../../shared/types";

/** What's open and what the server has told us, shared by the modules that make up the app. */
export const state = {
  selected: null as FileNode | null,
  /** Whether the server keeps version history (it needs git). */
  historyEnabled: false,
  /** Latest good PDF of the open document. */
  lastPdf: null as string | null,
  /** Tree root keys ("latex") → absolute folders. */
  roots: {} as Record<string, string>,
  /** The open workspace (folder), and the others opened recently. Set by the server's first message. */
  workspace: null as WorkspaceMessage | null,
  /** Recently opened paths in this workspace, most recent first (quick-open ranks by this). Loaded with the workspace. */
  recent: [] as string[],
};

/** The preview toolbar's document actions. */
export const ui = {
  title: $("preview-title"),
  exportButton: $<HTMLButtonElement>("export"),
  save: $("save-group"), // Save PDF and its menu
  download: $<HTMLAnchorElement>("download"),
  zoom: $("zoom"),
};

/** Earlier versions and comparisons can't be saved or zoomed: hide those actions meanwhile. */
export function hideDocumentActions() {
  ui.save.hidden = ui.download.hidden = ui.zoom.hidden = true;
}
