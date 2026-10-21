import { API, type SavedRequest } from "../../shared/protocol";
import { idbGet, idbSet } from "../core/idb";
import { state, ui } from "../core/state";
import { $, replay, toast } from "../core/util";

/**
 * Saving a document's PDF where you want it.
 *   Save PDF (⌘S)       overwrites the file you last saved this document to; the first time, it's Save As.
 *   Save As… (⌘⇧S)      the system's save dialog; the chosen file becomes what ⌘S overwrites.
 *   Save to Downloads   a plain download, a new file every time.
 * The dialog needs Chrome or Edge (showSaveFilePicker); elsewhere both Save and Save As download.
 * Every save leaves a marker in the document's version history ("Saved as draft-3.pdf").
 */

type Handle = FileSystemFileHandle & {
  queryPermission?: (o: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: "readwrite" }) => Promise<PermissionState>;
};
type Picker = (options: {
  suggestedName?: string;
  startIn?: Handle | "downloads" | "documents" | "desktop";
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<Handle>;

const picker = () => (window as Window & { showSaveFilePicker?: Picker }).showSaveFilePicker;
export const hasSaveDialog = () => typeof picker() === "function";

/** The file ⌘S writes to for the open document, if it has one (kept in sync for the Save menu). */
let saveTarget: Handle | null = null;
/** A save is running: more ⌘S presses meanwhile are ignored rather than queued or re-asking.
 *  Only the file write counts; the history marker is recorded in the background (the server orders them). */
let saving = false;

async function once(fn: () => Promise<void>) {
  if (saving) return;
  saving = true;
  try {
    await fn();
  } finally {
    saving = false;
  }
}

const keyFor = (doc: string) => `save:${state.workspace?.id ?? ""}:${doc}`;
const pdfName = () => `${state.selected!.name.replace(/\.tex$/, "")}.pdf`;

/**
 * Whether the open document can be saved now. Only a finished, successful build: otherwise the PDF on
 * screen is an older one than the source, and the history marker would point at the wrong version.
 */
function ready(): boolean {
  if (state.selected?.kind !== "doc" || !state.lastPdf) toast("Open a document that builds to save its PDF");
  else if (state.build === "running") toast("Still building. Save again when it's done, so the PDF matches your source.");
  else if (state.build === "failed") toast("The latest build failed, so the PDF is older than your source. Fix the errors (Logs, L), then save.");
  else return true;
  return false;
}

/** Load the open document's save target and show it in the Save menu. Called when a document opens. */
export async function loadSaveTarget() {
  const doc = state.selected?.kind === "doc" ? state.selected.path : null;
  saveTarget = doc ? ((await idbGet<Handle>(keyFor(doc))) ?? null) : null;
  if (doc !== (state.selected?.kind === "doc" ? state.selected.path : null)) return; // opened something else meanwhile
  showTarget();
}

export const hasSaveTarget = () => saveTarget !== null;

function showTarget() {
  $("save-again-name").textContent = saveTarget?.name ?? "";
  ui.exportButton.dataset.tip = saveTarget ? `Save over ${saveTarget.name}` : "Choose where to save the PDF";
}

export function savePdf() {
  return once(async () => {
    if (!ready()) return;
    if (!hasSaveDialog()) return download();
    if (!saveTarget || !(await allowed(saveTarget))) return chooseAndSave();
    try {
      await write(saveTarget);
    } catch (e) {
      // Moved, deleted or no longer writable: ask where instead.
      if ((e as DOMException).name !== "AbortError") return chooseAndSave();
    }
  });
}

export const saveAs = () => once(async () => (ready() ? chooseAndSave() : undefined));
export const saveToDownloads = () => once(async () => (ready() ? download() : undefined));

async function chooseAndSave() {
  const pick = picker();
  if (!pick) return download();
  let handle: Handle;
  try {
    handle = await pick({
      suggestedName: saveTarget?.name ?? pdfName(),
      startIn: saveTarget ?? "downloads",
      types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
    });
  } catch {
    return; // closed the dialog
  }
  // Remember the choice before writing, so ⌘S right after never asks again.
  const doc = state.selected!.path;
  saveTarget = handle;
  showTarget();
  await idbSet(keyFor(doc), handle);
  await write(handle);
}

async function download() {
  const a = document.createElement("a");
  a.href = `${state.lastPdf}&download`;
  a.click();
  toast(`Downloading ${pdfName()}`);
  replay(ui.exportButton, "saved");
  void mark("downloaded", pdfName());
}

async function write(handle: Handle) {
  const doc = state.selected!.path;
  const pdf = await (await fetch(state.lastPdf!)).blob();
  const out = await handle.createWritable();
  await out.write(pdf);
  await out.close();
  toast(`Saved ${handle.name}`);
  replay(ui.exportButton, "saved"); // every save shows, even one that adds no version (nothing changed)
  void mark("saved", handle.name, doc);
}

/** Permission to write the remembered file again (a click on "Allow" the first time in a session). */
async function allowed(handle: Handle): Promise<boolean> {
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return true;
  return (await handle.requestPermission?.({ mode: "readwrite" }).catch(() => "denied")) === "granted";
}

async function mark(how: SavedRequest["how"], name: string, doc = state.selected!.path) {
  const body: SavedRequest = { doc, name, how };
  await fetch(API.saved, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
}
