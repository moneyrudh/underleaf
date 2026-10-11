import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { isMac } from "./keys";

export type ClaudeStart = "continue" | "new" | "resume";

/**
 * What native terminals send for editing keys that xterm.js leaves alone, using
 * Claude Code's readline-style bindings. Keyed by "shift+enter", "meta+backspace", …
 */
const KEY_SEQUENCES: Record<string, string> = {
  // Newline without submitting: Ctrl+J (LF) works in every terminal per Claude Code's docs.
  "shift+enter": "\n",
  "alt+enter": "\n",
  ...(isMac
    ? {
        "meta+backspace": "\x15", // Ctrl+U: delete to line start (what iTerm2/Terminal.app send)
        "meta+arrowleft": "\x01", // Ctrl+A: line start
        "meta+arrowright": "\x05", // Ctrl+E: line end
        "alt+backspace": "\x1b\x7f", // Option+Delete: delete previous word
        "alt+arrowleft": "\x1bb", // Alt+B: word left
        "alt+arrowright": "\x1bf", // Alt+F: word right
      }
    : {}),
};

function chord(e: KeyboardEvent) {
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.metaKey && "meta", e.shiftKey && "shift"].filter(Boolean);
  return [...mods, e.key.toLowerCase()].join("+");
}

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
    this.term.attachCustomKeyEventHandler((e) => {
      const sequence = KEY_SEQUENCES[chord(e)];
      if (sequence === undefined) return true; // let xterm handle it
      if (e.type === "keydown") {
        e.preventDefault();
        this.send({ type: "input", data: sequence });
      }
      return false;
    });
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

  /** Start over: a fresh conversation, the most recent one, or Claude's session picker. */
  restart(start: ClaudeStart) {
    this.connect();
    this.send({ type: "restart", start });
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
