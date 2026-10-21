import { appClients } from "./clients";
import { build, latexChanged } from "../build/builds";
import { scheduleEditSnapshot } from "../history/snapshots";
import { docs, rescan, scheduleBrief, treeMessage } from "./trees";
import { keepWatching } from "../workspace/files";

/** Reacting to files changing on disk (you, your editor, or Claude). */

let pending: Timer | undefined;
const changed = new Set<string>();

let watcher: { stop: () => void } | null = null;

export async function startWatching(dir: string) {
  stopWatching();
  const w = keepWatching(dir, (f) => onFsChange(f ? `latex/${f}` : "latex"));
  watcher = w;
  await w.ready;
}

export function stopWatching() {
  watcher?.stop();
  watcher = null;
  clearTimeout(pending);
  changed.clear();
}

/** `treePath` is "latex/…" (or just "latex" when the folder itself was recreated). */
function onFsChange(treePath: string) {
  // Hidden paths (.underleaf/, .claude/, .git/) never affect the tree or a build.
  if (/(^|\/)(\.[^/]+|node_modules)(\/|$)/.test(treePath)) return;
  changed.add(treePath);
  if (treePath.startsWith("latex/")) {
    latexChanged();
    scheduleEditSnapshot();
  }
  clearTimeout(pending);
  // Editors (and Claude) often write a file in several steps; wait for things to settle.
  pending = setTimeout(async () => {
    const paths = [...changed];
    changed.clear();
    await rescan();
    const payload = JSON.stringify(treeMessage());
    for (const ws of appClients) ws.send(payload);
    // Rebuild what's open (an \input'd fragment may have changed) plus any document
    // that changed itself, so Claude's snapshot reflects edits to files nobody has open.
    const targets = new Set([...appClients].map((ws) => ws.data.doc).filter((d): d is string => !!d));
    for (const p of paths) if (docs.includes(p)) targets.add(p);
    for (const doc of targets) if (docs.includes(doc)) build(doc);
    scheduleBrief();
  }, 120);
}
