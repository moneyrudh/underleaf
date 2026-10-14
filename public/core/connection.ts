import * as preview from "../preview/preview";
import { onTree } from "../files/open";
import { versions } from "../history/versions";
import { diffView } from "../compare/compare";
import { state, ui } from "./state";
import { $, escapeHtml } from "./util";
import { SOCKETS, type ClientMessage, type ServerMessage } from "../../shared/protocol";

let ws: WebSocket;

export function connect() {
  ws = new WebSocket(`ws://${location.host}${SOCKETS.app}`);
  ws.onopen = () => {
    $("connection").hidden = true;
    if (state.selected?.kind === "doc") send({ type: "open", doc: state.selected.path }); // resubscribe after a reconnect
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerMessage);
  ws.onclose = () => {
    $("connection").hidden = false;
    setTimeout(connect, 1000);
  };
}

export function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg: ServerMessage) {
  if (msg.type === "tree") {
    state.roots = msg.roots;
    state.historyEnabled = msg.history;
    onTree(msg.trees);
    versions.setFile(state.selected?.path ?? null, state.historyEnabled);
    return;
  }
  if (msg.type === "history") return void versions.refresh();
  const selected = state.selected;
  if (!selected || msg.doc !== selected.path) return;

  // Comparing: a live side follows the build, and nothing else on screen changes.
  if (diffView.active) {
    if (msg.type === "compiled") {
      state.lastPdf = msg.pdf;
      diffView.livePdf(msg.doc, msg.pdf);
    }
    return;
  }

  // While an earlier version is on screen, keep tracking the live build but don't replace the view.
  if (msg.type === "compiling") return versions.viewing ? undefined : preview.setStatus("compiling…", "busy");
  if (versions.viewing) {
    state.lastPdf = msg.pdf;
    return;
  }

  const errors = msg.diagnostics.filter((d) => d.severity === "error").length;
  if (msg.ok) {
    preview.setStatus(`compiled in ${msg.ms}ms · ${msg.pages} page${msg.pages === 1 ? "" : "s"} · ${msg.engine}`, "ok");
  } else {
    preview.setStatus(`${errors || 1} error${errors > 1 ? "s" : ""}${msg.pdf ? " — showing last good PDF" : ""}`, "fail");
    preview.openLogs(); // surface errors the moment they happen
  }
  preview.showDiagnostics(msg.diagnostics);

  state.lastPdf = msg.pdf;
  ui.exportButton.disabled = !msg.pdf;
  ui.download.hidden = !msg.pdf;
  if (msg.pdf) {
    ui.download.href = `${msg.pdf}&download`;
    preview.showPdf(msg.pdf, { stale: !msg.ok });
  } else {
    preview.showMessage(`<strong>${escapeHtml(selected.name)}</strong> hasn't compiled yet — check the logs.`);
  }
}
