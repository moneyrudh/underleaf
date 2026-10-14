import type { Snapshot } from "../src/history";
import { HistoryPanel, relativeTime } from "./history";
import * as preview from "./preview";
import { open, reopen } from "./open";
import { closeCompare, comparing, compareVersions } from "./compare";
import { state, ui } from "./state";
import { toast } from "./util";

/** Looking at and restoring earlier versions of the open file. */

export const versions = new HistoryPanel({
  // While comparing versions, the strip (and , / .) moves the "before" side.
  onView: (snap) => (comparing ? compareVersions(snap, comparing.b) : viewSnapshot(snap)),
  onCurrent: () => (comparing?.b ? compareVersions(null, comparing.b) : reopen()),
  onCompare: (snap) => compareVersions(snap, null),
  onRestore: (snap) => restoreSnapshot(snap),
});

let snapshotPdfUrl: string | null = null; // object URL of the earlier version being viewed

export function leaveSnapshot() {
  if (versions.viewing) versions.showViewing(null);
  if (snapshotPdfUrl) URL.revokeObjectURL(snapshotPdfUrl);
  snapshotPdfUrl = null;
}

export async function viewSnapshot(snap: Snapshot) {
  const selected = state.selected;
  if (!selected || !snap.path) return;
  closeCompare();
  versions.showViewing(snap);
  if (preview.hasContent()) preview.beginLoading({ keepScroll: true }); // same file: keep your place
  ui.exportButton.hidden = ui.download.hidden = true; // an earlier version can't be saved; zoom still works
  const where = `${snap.label} · ${relativeTime(snap.time)}`;
  const query = `commit=${snap.id}&path=${encodeURIComponent(snap.path)}`;

  if (selected.kind === "doc" && snap.path.endsWith(".tex")) {
    preview.setStatus("compiling this version…", "busy");
    const res = await fetch(`/api/history/pdf?${query}`).catch(() => null);
    if (versions.viewing?.id !== snap.id) return; // moved on while it compiled
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { diagnostics?: preview.Diagnostic[] } | null;
      preview.showDiagnostics(body?.diagnostics ?? []);
      preview.showMessage("This version doesn't compile. Its errors are in <strong>Logs</strong>.");
      preview.setStatus(where, "fail");
      return;
    }
    if (snapshotPdfUrl) URL.revokeObjectURL(snapshotPdfUrl);
    snapshotPdfUrl = URL.createObjectURL(await res.blob());
    preview.showPdf(snapshotPdfUrl);
  } else if (selected.kind === "pdf") {
    preview.showPdf(`/api/history/file?${query}`);
  } else if (selected.kind === "image") {
    preview.showImage(`/api/history/file?${query}`);
  } else {
    preview.showText(`/api/history/file?${query}`);
  }
  preview.setStatus(where, "info");
}

async function restoreSnapshot(snap: Snapshot) {
  const selected = state.selected;
  if (!selected) return;
  const res = await fetch("/api/history/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commit: snap.id, path: snap.path, target: selected.path }),
  }).catch(() => null);
  if (!res?.ok) return toast("Couldn't restore that version");
  const { changed } = (await res.json()) as { changed: boolean };
  toast(
    !changed
      ? `${selected.name} already matches this version. Nothing to restore.`
      : snap.kind === "export"
        ? `Restored ${selected.name} to the exported version. The version you replaced is saved in history.`
        : `Restored ${selected.name}. The version you replaced is saved in history.`,
  );
  open(selected);
}
