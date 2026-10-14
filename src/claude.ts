import os from "node:os";
import path from "node:path";
import { access, constants } from "node:fs/promises";
import type { ServerWebSocket } from "bun";

const SCROLLBACK_BYTES = 512 * 1024;
const encoder = new TextEncoder();

/** How a session starts: pick up the latest conversation, start fresh, or show Claude's picker. */
export type ClaudeStart = "continue" | "new" | "resume";
const START_ARGS: Record<ClaudeStart, string[]> = { continue: ["--continue"], new: [], resume: ["--resume"] };

/**
 * One interactive `claude` process in a PTY, shared by every open browser tab.
 * It survives page reloads: reconnecting tabs get the recent output replayed.
 * We run the user's own, unmodified Claude Code install with their own login.
 */
export class ClaudeSession {
  private proc?: Bun.Subprocess;
  private scrollback: Uint8Array[] = [];
  private scrollbackSize = 0;
  private clients = new Set<ServerWebSocket<unknown>>();
  private cols = 100;
  private rows = 30;
  private sized = false; // the browser has reported the pane's real size

  constructor(
    private cwd: string,
    private extraEnv: Record<string, string> = {},
    /** Called whenever the `claude` process exits or is replaced. */
    private onExit: () => void = () => {},
  ) {}

  attach(ws: ServerWebSocket<unknown>) {
    this.clients.add(ws);
    for (const chunk of this.scrollback) ws.send(chunk);
    // Wait for the pane's size so Claude's first screen is drawn at the right width
    // (the tab sends it right after connecting; fall back if it never does).
    if (!this.proc && !this.sized) setTimeout(() => !this.proc && !this.sized && this.start("continue"), 1000);
    else if (!this.proc) this.start("continue");
  }

  detach(ws: ServerWebSocket<unknown>) {
    this.clients.delete(ws);
  }

  input(data: string) {
    if (this.proc) this.proc.terminal?.write(data);
    else if (data.includes("\r")) this.start("continue");
  }

  resize(cols: number, rows: number) {
    if (!(cols > 0 && rows > 0)) return;
    this.cols = cols;
    this.rows = rows;
    this.proc?.terminal?.resize(cols, rows);
    if (!this.sized) {
      this.sized = true;
      if (!this.proc && this.clients.size > 0) this.start("continue");
    }
  }

  restart(start: ClaudeStart) {
    const old = this.proc;
    this.proc = undefined; // so its exit message is suppressed
    old?.kill();
    old?.terminal?.close();
    this.clear();
    this.start(start);
  }

  stop() {
    this.proc?.kill();
  }

  private async start(start: ClaudeStart) {
    const bin = process.env.UNDERLEAF_CLAUDE_BIN ?? Bun.which("claude"); // the override is for tests (a stand-in CLI)
    if (!bin) {
      this.emit(
        "\x1b[33mClaude Code isn't installed.\x1b[0m\r\n\r\n" +
          "Install it from https://claude.com/claude-code, run `claude` once to log in,\r\n" +
          "then press Enter here.\r\n",
      );
      return;
    }
    await this.warnIfConfigUnreadable();

    const env: Record<string, string | undefined> = { ...process.env, ...this.extraEnv, TERM: "xterm-256color", COLORTERM: "truecolor" };
    delete env.CLAUDECODE; // underleaf may itself be launched from inside a Claude Code session

    const startedAt = performance.now();
    const proc = Bun.spawn([bin, ...START_ARGS[start]], {
      cwd: this.cwd,
      env,
      terminal: { cols: this.cols, rows: this.rows, data: (_t, data) => this.emit(data) },
    });
    this.proc = proc;
    proc.exited.then((code) => {
      this.onExit();
      if (this.proc !== proc) return;
      this.proc = undefined;
      proc.terminal?.close();
      // `--continue` with no earlier conversation in this folder fails right away: start fresh instead.
      if (start === "continue" && code !== 0 && performance.now() - startedAt < 5000) {
        this.clear();
        this.start("new");
        return;
      }
      this.emit(`\r\n\x1b[2m[claude exited${code ? ` with code ${code}` : ""} — press Enter to pick up where you left off]\x1b[0m\r\n`);
    });
  }

  /**
   * A root-owned ~/.claude.json (typically from running `sudo claude` once) can't be
   * read or saved, so Claude Code shows first-run setup on every launch.
   */
  private async warnIfConfigUnreadable() {
    if (process.env.CLAUDE_CONFIG_DIR) return;
    const file = path.join(os.homedir(), ".claude.json");
    const exists = await access(file).then(() => true, () => false);
    const usable = await access(file, constants.R_OK | constants.W_OK).then(() => true, () => false);
    if (!exists || usable) return;
    this.emit(
      "\x1b[33m⚠ Claude Code can't read or save ~/.claude.json.\r\n" +
        "  It's owned by another user, usually from running\r\n" +
        "  `sudo claude` once, so setup appears every launch.\r\n" +
        "  Fix it in a terminal:\r\n" +
        `    sudo chown ${os.userInfo().username} ~/.claude.json\x1b[0m\r\n\r\n`,
    );
  }

  private clear() {
    this.scrollback = [];
    this.scrollbackSize = 0;
    this.emit("\x1b[2J\x1b[3J\x1b[H"); // clear screen + scrollback for the new session
  }

  private emit(data: Uint8Array | string) {
    // Copy: the PTY may reuse its read buffer.
    const bytes = typeof data === "string" ? encoder.encode(data) : data.slice();
    this.scrollback.push(bytes);
    this.scrollbackSize += bytes.byteLength;
    while (this.scrollbackSize > SCROLLBACK_BYTES && this.scrollback.length > 1) {
      this.scrollbackSize -= this.scrollback.shift()!.byteLength;
    }
    for (const ws of this.clients) ws.send(bytes);
  }
}
