import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/**
 * The real Claude Code TUI, running in a PTY on the server and drawn here with xterm.js.
 * The connection is lazy so a hidden pane doesn't start a `claude` process.
 */
export class ClaudeTerminal {
  private term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: false,
    cursorInactiveStyle: "outline", // hollow cursor when another pane has focus
    allowProposedApi: true,
    theme: { background: "#141a16", foreground: "#dfe6e1", cursor: "#4caf6e", selectionBackground: "#2f4a39" },
  });
  private fit = new FitAddon();
  private ws?: WebSocket;

  constructor(private el: HTMLElement) {
    this.term.loadAddon(this.fit);
    this.term.open(el);
    this.term.onData((data) => this.send({ type: "input", data }));
    // Blink only while focused, so it's obvious where typing goes.
    this.term.textarea?.addEventListener("focus", () => (this.term.options.cursorBlink = true));
    this.term.textarea?.addEventListener("blur", () => (this.term.options.cursorBlink = false));
    new ResizeObserver(() => this.resize()).observe(el);
  }

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(`ws://${location.host}/claude`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.term.reset(); // the server replays recent output
      this.resize();
    };
    ws.onmessage = (e) => this.term.write(new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.term.write("\r\n\x1b[2m[disconnected — retrying…]\x1b[0m\r\n");
      setTimeout(() => this.connect(), 1500);
    };
    this.ws = ws;
  }

  focus() {
    this.connect();
    this.term.focus();
  }

  /** Type text into Claude's prompt (e.g. an @file mention) without sending it. */
  paste(text: string) {
    this.focus();
    this.term.paste(text);
  }

  restart() {
    this.connect();
    this.send({ type: "restart" });
    this.term.focus();
  }

  private resize() {
    if (!this.el.offsetParent) return; // hidden
    this.fit.fit();
    this.send({ type: "resize", cols: this.term.cols, rows: this.term.rows });
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
