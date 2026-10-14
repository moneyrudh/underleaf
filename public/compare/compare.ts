import { DiffView, type Side } from "./view";
import { KIND_ICONS, relativeTime } from "../history/panel";
import { openPalette } from "../ui/palette";
import { reopen, tree } from "../files/open";
import { leaveSnapshot, versions } from "../history/versions";
import { focusPane } from "../core/layout";
import { hideDocumentActions, state } from "../core/state";
import { $, toast } from "../core/util";
import type { FileNode, Snapshot } from "../../shared/types";
import { API, url } from "../../shared/protocol";

/** Comparing two versions of the open file, or two files. The view itself lives in diff.ts. */

export const diffView = new DiffView({
  onPick: (which, value) => {
    if (!comparing) return;
    const snap = value === "now" ? null : (versions.all.find((s) => s.id === value) ?? null);
    compareVersions(which === "a" ? snap : comparing.a, which === "b" ? snap : comparing.b);
  },
  onClose: () => reopen(),
});

/** Versions of the open file being compared (null = its current state), or null when comparing two files. */
export let comparing: { a: Snapshot | null; b: Snapshot | null } | null = null;

export const COMPARABLE = new Set(["doc", "tex", "text"]);
export const canCompare = () => !!state.selected && COMPARABLE.has(state.selected.kind);

export function closeCompare() {
  comparing = null;
  diffView.close();
}

function versionSide(snap: Snapshot | null): Side {
  const file = state.selected!;
  if (!snap) return { path: file.path, label: "Current version", pdf: state.lastPdf, doc: file.kind === "doc" };
  return {
    path: file.path,
    label: `${snap.label} · ${relativeTime(snap.time)}`,
    commit: snap.id,
    snapPath: snap.path,
    doc: file.kind === "doc" && !!snap.path?.endsWith(".tex"),
  };
}

function enterCompare() {
  hideDocumentActions();
  $("logs").hidden = true; // the current build's logs would only squeeze the comparison
  focusPane("preview");
}

export async function compareVersions(a: Snapshot | null, b: Snapshot | null) {
  if (!canCompare()) return toast("Only LaTeX and text files can be compared");
  comparing = { a, b };
  versions.showViewing(a); // the version strip marks the "before" side
  enterCompare();
  const options = [
    { value: "now", label: "Current version", meta: "live", icon: "●", kind: "current" },
    ...versions.all.map((s) => ({ value: s.id, label: s.label, meta: `${s.author} · ${relativeTime(s.time)}`, icon: KIND_ICONS[s.kind], kind: s.kind })),
  ];
  await diffView.show(versionSide(a), versionSide(b), options, [a?.id ?? "now", b?.id ?? "now"]);
}

/** C: what changed since the last version that differs from the file as it is now. */
export async function compareWithPrevious() {
  const file = state.selected;
  if (!file || !canCompare()) return toast("Open a LaTeX or text file to compare its versions");
  if (!versions.enabled) return toast("Version history covers files in latex/");
  if (versions.viewing) return compareVersions(versions.viewing, null);
  const snaps = (await versions.load()).filter((s) => s.path);
  const text = async (url: string) => {
    const res = await fetch(url).catch(() => null);
    return res?.ok ? res.text() : null;
  };
  const now = await text(url(API.file, { path: file.path, t: Date.now() }));
  // The newest snapshots often match the file as it is (they were taken from it); skip those.
  for (const snap of snaps.slice(0, 25)) {
    const then = await text(url(API.historyFile, { commit: snap.id, path: snap.path }));
    if (state.selected?.path !== file.path) return; // opened something else meanwhile
    if (then !== now) return compareVersions(snap, null);
  }
  toast(snaps.length ? `No earlier version of ${file.name} differs from it` : `No earlier versions of ${file.name} yet`);
}

/** C again (or Esc) closes; otherwise compare with the previous version. */
export function toggleCompare() {
  if (diffView.active) reopen();
  else compareWithPrevious();
}

/** Compare the open file with another one (both as they are now). */
export function compareWithFile() {
  const from = state.selected;
  if (!from || !canCompare()) return toast("Open a LaTeX or text file to compare");
  const others = tree.files().filter((f) => f.path !== from.path && COMPARABLE.has(f.kind));
  const rank = (f: FileNode) => (f.kind === from.kind ? 0 : 1); // same kind first: two documents get the reader view
  openPalette({
    placeholder: `Compare ${from.name} with…`,
    emptyText: "No other files to compare with",
    items: others.sort((x, y) => rank(x) - rank(y) || x.path.localeCompare(y.path)).map((f) => ({ label: f.path, run: () => compareFiles(from, f) })),
  });
}

function compareFiles(a: FileNode, b: FileNode) {
  closeCompare();
  leaveSnapshot();
  enterCompare();
  const side = (f: FileNode): Side => ({ path: f.path, label: f.path, pdf: f.path === state.selected?.path ? state.lastPdf : null, doc: f.kind === "doc" });
  diffView.show(side(a), side(b));
}
