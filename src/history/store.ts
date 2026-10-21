import path from "node:path";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import type { Snapshot, SnapshotAuthor, SnapshotKind } from "../../shared/types";
import { HOME } from "../home";

/**
 * Version history for a workspace, stored outside it in ~/.underleaf/history/<id>.git.
 * Plain git with a separate git dir: latex/ never gets a .git folder, renames are
 * detected (so a file's history follows it), and old versions are readable with git.
 */


type SnapshotRequest = {
  kind: SnapshotKind;
  author: SnapshotAuthor;
  /** A fixed label, or one built from the workspace-relative paths that changed. */
  label: string | ((changed: string[]) => string);
  /** Record the snapshot even if nothing changed (exports mark a moment, not a change). */
  allowEmpty?: boolean;
  /** Workspace-relative file this snapshot is about (exports), so it shows in that file's timeline. */
  about?: string;
};

const SEP_RECORD = "\x1e";
const SEP_FIELD = "\x1f";
const EMAILS: Record<SnapshotAuthor, string> = { You: "you@underleaf", Claude: "claude@underleaf", underleaf: "app@underleaf" };

// Never versioned: underleaf's generated files, nested repos, OS and editor junk.
const EXCLUDES = [".underleaf/", ".git/", ".DS_Store", "*.swp", "*~", ".#*"];

export class HistoryStore {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private workDir: string,
    readonly gitDir: string,
  ) {}

  /** Returns null when git isn't installed; the app then runs without history. */
  static async open(workDir: string): Promise<HistoryStore | null> {
    if (!Bun.which("git")) return null;
    const id = await workspaceId(workDir);
    const store = new HistoryStore(workDir, path.join(HOME, "history", `${id}.git`));
    await store.init();
    return store;
  }

  private async init() {
    if (!(await Bun.file(path.join(this.gitDir, "HEAD")).exists())) {
      await mkdir(path.dirname(this.gitDir), { recursive: true });
      await run(["git", "init", "--quiet", "--bare", this.gitDir]);
      await this.git(["config", "core.bare", "false"]);
    }
    await this.git(["config", "core.quotePath", "false"]);
    await this.git(["config", "core.autocrlf", "false"]);
    await Bun.write(path.join(this.gitDir, "info", "exclude"), EXCLUDES.join("\n") + "\n");
    const hasCommits = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false);
    if (!hasCommits) await this.snapshot({ kind: "init", author: "underleaf", label: "Started tracking history", allowEmpty: true });
  }

  /** Commit the workspace as it is now. Returns null when there was nothing to record. */
  snapshot(req: SnapshotRequest): Promise<Snapshot | null> {
    return this.serial(async () => {
      await this.git(["add", "--all"]);
      const changed = (await this.git(["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
      if (changed.length === 0 && !req.allowEmpty) return null;

      const label = typeof req.label === "string" ? req.label : req.label(changed);
      const trailers = [`Underleaf-Kind: ${req.kind}`, ...(req.about ? [`Underleaf-Path: ${req.about}`] : [])];
      await this.git([
        "-c", `user.name=${req.author}`,
        "-c", `user.email=${EMAILS[req.author]}`,
        "-c", "commit.gpgsign=false",
        "commit", "--quiet", "--no-verify", "--allow-empty",
        "-m", label, "-m", trailers.join("\n"),
      ]);
      const id = (await this.git(["rev-parse", "HEAD"])).trim();
      return { id, time: Date.now(), author: req.author, kind: req.kind, label, path: req.about };
    });
  }

  /** Whether the workspace is exactly as it was at `commit` (every file, not just one). */
  unchangedSince(commit: string): Promise<boolean> {
    return this.serial(async () => {
      await this.git(["add", "--all"]);
      return this.git(["diff", "--cached", "--quiet", commit]).then(() => true, () => false); // exit 1 = differences
    });
  }

  /** Timeline for one file (following renames), newest first, including exports of it. */
  async log(relPath: string, limit = 200): Promise<Snapshot[]> {
    const format = `--format=${SEP_RECORD}%H${SEP_FIELD}%at${SEP_FIELD}%an${SEP_FIELD}%s${SEP_FIELD}%(trailers:key=Underleaf-Kind,valueonly,separator=)${SEP_FIELD}%(trailers:key=Underleaf-Path,valueonly,separator=)`;
    const [changes, exports, order] = await Promise.all([
      this.git(["log", "--follow", "-M", `-n${limit}`, "--name-status", format, "--", relPath]),
      this.git(["log", `-n${limit}`, format, "--fixed-strings", `--grep=Underleaf-Path: ${relPath}`]),
      this.git(["rev-list", "HEAD"]),
    ]);
    // Order by commit sequence, not timestamp: git times have 1s resolution and snapshots often share a second.
    const rank = new Map(order.split("\n").filter(Boolean).map((id, i) => [id, i]));

    const snapshots = new Map<string, Snapshot>();
    for (const record of changes.split(SEP_RECORD).filter((r) => r.trim())) {
      const snap = parseRecord(record);
      // --name-status lines: "M\tpath", "A\tpath", "R098\told\tnew". The last column is the path at this commit.
      const status = record.split("\n").slice(1).find((l) => /^[AMRDC]/.test(l));
      snap.path = status?.split("\t").at(-1) ?? relPath;
      snapshots.set(snap.id, snap);
    }
    for (const record of exports.split(SEP_RECORD).filter((r) => r.trim())) {
      const snap = parseRecord(record);
      if (snap.path === relPath) snapshots.set(snap.id, snap); // --grep is a substring match; require the exact path
    }
    return [...snapshots.values()].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }

  /** A file's bytes as of a snapshot. */
  async readFile(commit: string, relPath: string): Promise<Uint8Array<ArrayBuffer>> {
    const proc = Bun.spawn(this.cmd(["show", `${commit}:${relPath}`]), { stdout: "pipe", stderr: "pipe" });
    const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    if ((await proc.exited) !== 0) throw new Error(`no ${relPath} at ${commit}`);
    return bytes;
  }

  /** Write a snapshot's whole tree into `dest` (needed to compile documents that \input other files). */
  async exportTree(commit: string, dest: string): Promise<void> {
    await mkdir(dest, { recursive: true });
    const archive = Bun.spawn(this.cmd(["archive", "--format=tar", commit]), { stdout: "pipe", stderr: "pipe" });
    const tar = Bun.spawn(["tar", "-x", "-C", dest], { stdin: archive.stdout, stderr: "pipe" });
    const [a, t] = await Promise.all([archive.exited, tar.exited]);
    if (a !== 0 || t !== 0) throw new Error(`could not export snapshot ${commit}`);
  }

  /**
   * Put a file back to how it was at `commit`. The current state is recorded first,
   * so a restore can itself be undone. Returns "unchanged" when the file already matches.
   */
  async restore(commit: string, fromRel: string, toRel: string): Promise<Snapshot | null | "unchanged"> {
    const bytes = await this.readFile(commit, fromRel);
    const current = await Bun.file(path.join(this.workDir, toRel)).bytes().catch(() => null);
    if (current && Buffer.from(current).equals(Buffer.from(bytes))) return "unchanged";
    await this.snapshot({ kind: "edit", author: "You", label: (c) => editLabel(c) });
    await Bun.write(path.join(this.workDir, toRel), bytes);
    const short = commit.slice(0, 7);
    return this.snapshot({ kind: "restore", author: "You", label: `Restored ${toRel} to version ${short}` });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    // One git operation at a time: concurrent `add`/`commit` would fight over index.lock.
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private cmd(args: string[]) {
    return ["git", `--git-dir=${this.gitDir}`, `--work-tree=${this.workDir}`, ...args];
  }

  private git(args: string[]) {
    return run(this.cmd(args));
  }
}

/** "You edited main.tex" / "You edited 3 files" */
export function editLabel(changed: string[], who = "You edited"): string {
  // Name your documents; agent memory and config changes ride along without being the headline.
  const files = changed.filter((f) => !f.startsWith("memory/") && !f.startsWith(".claude/") && f !== "CLAUDE.md");
  const list = files.length ? files : changed;
  if (list.length === 1) return `${who} ${list[0]}`;
  return `${who} ${list.length} files`;
}

function parseRecord(record: string): Snapshot {
  const [id = "", at = "0", author = "underleaf", subject = "", kind = "", about = ""] = record.split("\n")[0]!.split(SEP_FIELD);
  return {
    id,
    time: Number(at) * 1000,
    author: (["You", "Claude", "underleaf"].includes(author) ? author : "You") as SnapshotAuthor,
    kind: (kind.trim() || "edit") as SnapshotKind,
    label: subject,
    path: about.trim() || undefined,
  };
}

/** Stable id stored in the workspace, so history survives moving or renaming the folder. */
export async function workspaceId(workDir: string): Promise<string> {
  const file = Bun.file(path.join(workDir, ".underleaf", "id"));
  const existing = (await file.text().catch(() => "")).trim();
  if (/^[\w-]{8,}$/.test(existing)) return existing;
  const id = crypto.randomUUID();
  await Bun.write(path.join(workDir, ".underleaf", "id"), id + "\n");
  return id;
}

/**
 * Give a copied workspace (same id as the folder it was copied from) an id of its own. Its history
 * starts as a copy of the original's, so past versions stay, and from here the two are separate.
 */
export async function forkWorkspaceId(workDir: string, fromId: string): Promise<string> {
  const id = crypto.randomUUID();
  const from = path.join(HOME, "history", `${fromId}.git`);
  const to = path.join(HOME, "history", `${id}.git`);
  if ((await stat(from).catch(() => null))?.isDirectory()) {
    await cp(from, to, { recursive: true });
    await rm(path.join(to, "index.lock"), { force: true }); // in case the original was mid-snapshot
  }
  await Bun.write(path.join(workDir, ".underleaf", "id"), id + "\n");
  return id;
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 4).join(" ")} … failed: ${err.trim()}`);
  return out;
}
