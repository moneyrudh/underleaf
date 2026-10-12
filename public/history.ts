import type { Snapshot } from "../src/history";
import { $, storage } from "./util";

const KIND_ICONS: Record<Snapshot["kind"], string> = { claude: "✦", edit: "✎", export: "⤓", restore: "↺", init: "•" };

type Handlers = {
  onView: (snap: Snapshot) => void;
  onCurrent: () => void;
  onRestore: (snap: Snapshot) => Promise<void>;
};

/**
 * Version history for the open file, in two views that share one list and one
 * "which version is on screen" state:
 *  • the version strip: a slim timeline above the preview, always at hand
 *  • the History panel: the full list with labels, beside the preview
 * plus the banner shown while you're looking at an older version.
 */
export class HistoryPanel {
  private panel = $("history");
  private list = $("history-list");
  private button = $("toggle-history");
  private banner = $("snapshot-banner");
  private restoreButton = $<HTMLButtonElement>("snapshot-restore");
  private strip = $("version-strip");
  private track = $("version-track");
  private tip = $("version-tip");
  private stripOn = storage("version-strip") !== "0";
  private available = false;
  private path: string | null = null;
  private snapshots: Snapshot[] = [];
  private armTimer: ReturnType<typeof setTimeout> | undefined;
  viewing: Snapshot | null = null;

  constructor(private handlers: Handlers) {
    this.button.onclick = () => this.toggle();
    $("hide-strip").onclick = () => this.toggleStrip();

    // A plain mouse wheel scrolls vertically; let it move the timeline sideways too.
    const scroller = this.track.parentElement!;
    scroller.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || scroller.scrollWidth <= scroller.clientWidth) return;
        scroller.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );
    scroller.addEventListener("scroll", () => this.updateFades());
    new ResizeObserver(() => this.updateFades()).observe(scroller);
    $("snapshot-back").onclick = () => handlers.onCurrent();
    // Restoring overwrites the file (the current state is saved first), so ask for a second click.
    this.restoreButton.onclick = async () => {
      if (!this.viewing) return;
      if (!this.restoreButton.classList.contains("armed")) {
        this.restoreButton.classList.add("armed");
        this.restoreButton.textContent = "Click again to restore";
        clearTimeout(this.armTimer);
        this.armTimer = setTimeout(() => this.disarm(), 3000);
        return;
      }
      this.disarm();
      await handlers.onRestore(this.viewing);
    };
  }

  /** Called when the open file changes. History only covers files in latex/. */
  setFile(path: string | null, enabled: boolean) {
    const available = enabled && !!path?.startsWith("latex/");
    const changed = path !== this.path || available !== this.available;
    this.available = available;
    this.button.hidden = !available;
    if (!available) this.panel.hidden = true;
    if (changed) {
      this.path = path;
      this.snapshots = [];
      this.showViewing(null);
      this.refresh();
    }
  }

  get open() {
    return !this.panel.hidden;
  }

  toggle() {
    if (this.button.hidden) return;
    this.panel.hidden = !this.panel.hidden;
    if (!this.panel.hidden) {
      $("logs").hidden = true; // one side panel at a time
      this.refresh();
    }
  }

  close() {
    this.panel.hidden = true;
  }

  get stripVisible() {
    return this.stripOn;
  }

  /** Show or hide the version strip (remembered). */
  toggleStrip() {
    this.stripOn = !this.stripOn;
    storage("version-strip", this.stripOn ? "1" : "0");
    this.refresh();
    this.renderStrip();
  }

  /** Step through versions from the keyboard: -1 = older, +1 = newer ("Current" is the newest). */
  step(dir: 1 | -1) {
    if (!this.available || this.snapshots.length === 0) return;
    // snapshots are newest-first; index -1 stands for the live file
    const at = this.viewing ? this.snapshots.findIndex((s) => s.id === this.viewing!.id) : -1;
    const next = Math.max(-1, Math.min(this.snapshots.length - 1, at - dir));
    if (next === at) return;
    if (next === -1) this.handlers.onCurrent();
    else this.handlers.onView(this.snapshots[next]!);
  }

  async refresh() {
    if (!this.path || !this.available || (this.panel.hidden && !this.stripOn)) return;
    const forPath = this.path;
    const res = await fetch(`/api/history?path=${encodeURIComponent(forPath)}`).catch(() => null);
    if (!res?.ok || forPath !== this.path) return;
    const body = (await res.json()) as { snapshots: Snapshot[] };
    this.snapshots = body.snapshots;
    this.render();
  }

  /** Mark which version the preview is showing (null = the live file). */
  showViewing(snap: Snapshot | null) {
    this.viewing = snap;
    this.disarm();
    this.banner.hidden = !snap;
    if (snap) {
      const what = this.banner.querySelector(".snapshot-what")!;
      what.textContent = "";
      const strong = document.createElement("strong");
      if (snap.kind === "export") {
        // An export marks what you sent: say so, with an exact date rather than "3d ago".
        const pdf = snap.label.replace(/^Exported /, "");
        strong.textContent = "This is the version you exported";
        what.append(strong, ` as ${pdf} · ${absoluteTime(snap.time)}`);
      } else {
        strong.textContent = "Viewing an earlier version";
        what.append(strong, ` · ${snap.label} · ${relativeTime(snap.time)}`);
      }
    }
    this.render();
  }

  private disarm() {
    clearTimeout(this.armTimer);
    this.restoreButton.classList.remove("armed");
    this.restoreButton.textContent = this.viewing?.kind === "export" ? "Restore the exported version" : "Restore this version";
  }

  /** Fade an edge of the timeline only when there's more to scroll on that side. */
  private updateFades() {
    const s = this.track.parentElement!;
    s.classList.toggle("more-left", s.scrollLeft > 1);
    s.classList.toggle("more-right", s.scrollLeft + s.clientWidth < s.scrollWidth - 1);
  }

  private render() {
    this.renderStrip();
    if (this.panel.hidden) return;
    const rows: HTMLElement[] = [];

    const current = document.createElement("li");
    current.className = "current";
    current.classList.toggle("active", !this.viewing);
    current.innerHTML = `<span class="kind">●</span><span class="what"><span class="label">Current version</span><span class="meta">live</span></span>`;
    current.onclick = () => this.handlers.onCurrent();
    rows.push(current);

    for (const snap of this.snapshots) {
      const li = document.createElement("li");
      li.className = `kind-${snap.kind}`;
      li.classList.toggle("active", this.viewing?.id === snap.id);
      li.title = `${snap.label}\n${new Date(snap.time).toLocaleString()}${snap.path && snap.path !== this.path?.slice(6) ? `\nthen named ${snap.path}` : ""}`;
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = KIND_ICONS[snap.kind] ?? "•";
      const what = document.createElement("span");
      what.className = "what";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = snap.label; // labels include Claude prompts: text only, never HTML
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${snap.author} · ${relativeTime(snap.time)}`;
      what.append(label, meta);
      li.append(kind, what);
      li.onclick = () => this.handlers.onView(snap);
      rows.push(li);
    }

    if (this.snapshots.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "No history yet. Snapshots appear when you pause editing, when Claude finishes a turn, and when you save a PDF.";
      rows.push(empty);
    }
    this.list.replaceChildren(...rows);
  }

  private renderStrip() {
    this.strip.hidden = !(this.available && this.stripOn);
    if (this.strip.hidden) return;

    const make = (cls: string, glyph: string, active: boolean, tipText: () => [string, string], onClick: () => void) => {
      const li = document.createElement("li");
      const dot = document.createElement("button");
      dot.className = `vdot ${cls}`;
      dot.classList.toggle("active", active);
      dot.textContent = glyph;
      dot.onclick = onClick;
      const show = () => this.showTip(dot, ...tipText());
      const hide = () => (this.tip.hidden = true);
      dot.addEventListener("mouseenter", show);
      dot.addEventListener("focus", show);
      dot.addEventListener("mouseleave", hide);
      dot.addEventListener("blur", hide);
      li.append(dot);
      return li;
    };

    // Oldest on the left, "Now" on the right, like a timeline.
    const items = [...this.snapshots].reverse().map((snap) =>
      make(`kind-${snap.kind}`, KIND_ICONS[snap.kind] ?? "•", this.viewing?.id === snap.id,
        () => [snap.label, `${snap.author} · ${relativeTime(snap.time)}`], () => this.handlers.onView(snap)),
    );
    const now = make("now", "Now", !this.viewing, () => ["Current version", "live"], () => this.handlers.onCurrent());
    this.track.replaceChildren(...items, now);

    // Keep the version on screen in view (the newest end by default).
    // Keep the version on screen in view; "Now" means the very end of the timeline.
    const scroller = this.track.parentElement!;
    if (!this.viewing) scroller.scrollLeft = scroller.scrollWidth;
    else this.track.querySelector<HTMLElement>(".vdot.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.updateFades();
  }

  private showTip(dot: HTMLElement, title: string, meta: string) {
    this.tip.textContent = "";
    const t = document.createElement("strong");
    t.textContent = title; // labels can contain Claude prompts: text only
    const m = document.createElement("span");
    m.textContent = meta;
    this.tip.append(t, m);
    this.tip.hidden = false;
    const strip = this.strip.getBoundingClientRect();
    const box = dot.getBoundingClientRect();
    const width = this.tip.offsetWidth;
    const left = Math.max(8, Math.min(strip.width - width - 8, box.left - strip.left + box.width / 2 - width / 2));
    this.tip.style.left = `${left}px`;
  }
}

export function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (hours < 48) return `yesterday ${time}`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" }) + ` ${time}`;
}
