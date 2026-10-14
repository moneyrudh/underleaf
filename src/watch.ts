import { LATEX, RESUMES } from "./config";
import { appClients } from "./clients";
import { build, latexChanged } from "./builds";
import { scheduleEditSnapshot } from "./snapshots";
import { docs, rescan, scheduleBrief, treeMessage } from "./trees";
import { keepWatching } from "./workspace";

/** Reacting to files changing on disk (you, your editor, or Claude). */

let pending: Timer | undefined;
const changed = new Set<string>();

export async function startWatching() {
  await keepWatching(LATEX, (f) => onFsChange(f ? `latex/${f}` : "latex"));
  await keepWatching(RESUMES, (f) => onFsChange(f ? `resumes/${f}` : "resumes"));
}

/** `treePath` is "latex/…" or "resumes/…" (or just the root key when a root was recreated). */
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
    const payload = treeMessage();
    for (const ws of appClients) ws.send(payload);
    // Rebuild what's open (an \input'd fragment may have changed) plus any document
    // that changed itself, so Claude's snapshot reflects edits to files nobody has open.
    const targets = new Set([...appClients].map((ws) => ws.data.doc).filter((d): d is string => !!d));
    for (const p of paths) if (docs.includes(p)) targets.add(p);
    for (const doc of targets) if (docs.includes(doc)) build(doc);
    scheduleBrief();
  }, 120);
}
