import type { ServerWebSocket } from "bun";

const SCROLLBACK_BYTES = 512 * 1024;
const encoder = new TextEncoder();

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

  constructor(private cwd: string) {}

  attach(ws: ServerWebSocket<unknown>) {
    this.clients.add(ws);
    for (const chunk of this.scrollback) ws.send(chunk);
    if (!this.proc) this.start();
  }

  detach(ws: ServerWebSocket<unknown>) {
    this.clients.delete(ws);
  }

  input(data: string) {
    if (this.proc) this.proc.terminal?.write(data);
    else if (data.includes("\r")) this.start();
  }

  resize(cols: number, rows: number) {
    if (!(cols > 0 && rows > 0)) return;
    this.cols = cols;
    this.rows = rows;
    this.proc?.terminal?.resize(cols, rows);
  }

  stop() {
    this.proc?.kill();
  }

  private start() {
    const bin = Bun.which("claude");
    if (!bin) {
      this.emit(
        "\x1b[33mClaude Code isn't installed.\x1b[0m\r\n\r\n" +
          "Install it from https://claude.com/claude-code, run `claude` once to log in,\r\n" +
          "then press Enter here.\r\n",
      );
      return;
    }

    const env: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
    delete env.CLAUDECODE; // underleaf may itself be launched from inside a Claude Code session

    const proc = Bun.spawn([bin], {
      cwd: this.cwd,
      env,
      terminal: { cols: this.cols, rows: this.rows, data: (_t, data) => this.emit(data) },
    });
    this.proc = proc;
    proc.exited.then((code) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      proc.terminal?.close();
      this.emit(`\r\n\x1b[2m[claude exited${code ? ` with code ${code}` : ""} — press Enter to start a new session]\x1b[0m\r\n`);
    });
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
