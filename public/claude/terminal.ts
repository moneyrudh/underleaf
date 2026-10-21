import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { isMac } from "../core/keys";
import type { ClaudeStart } from "../../shared/types";
import { SOCKETS, type ClaudeClientMessage } from "../../shared/protocol";


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

const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * The real Claude Code TUI, running in a PTY on the server and drawn here with xterm.js.
 * The connection is lazy so a hidden pane doesn't start a `claude` process.
 */
export class ClaudeTerminal {
  private term = new Terminal({
    fontFamily: MONO,
    fontSize: 13,
    cursorBlink: false,
    cursorInactiveStyle: "outline", // hollow cursor when another pane has focus
    allowProposedApi: true,
    // Matches --term / --term-ink in styles/tokens.css: the pane is dark in both themes.
    theme: { background: "#121915", foreground: "#dfe7e1", cursor: "#6cc28a", selectionBackground: "#2f4a39" },
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
    // xterm measures character cells when it opens; measure again once the bundled font is in.
    document.fonts.load(`13px "JetBrains Mono"`).then(() => {
      this.term.options.fontFamily = "monospace"; // a real change, so xterm re-measures
      this.term.options.fontFamily = MONO;
      this.resize();
    });
  }

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(`ws://${location.host}${SOCKETS.claude}`);
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

  private send(msg: ClaudeClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
