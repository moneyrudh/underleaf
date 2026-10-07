import * as pdfjs from "pdfjs-dist";
import { $ } from "./util";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";

export type Diagnostic = { severity: "error" | "warning"; file?: string; line?: number; message: string };

const viewer = $("viewer");
const logs = $("logs");
const logsButton = $("toggle-logs");
const diagnosticsEl = $("diagnostics");
const statusEl = $("status");

let currentPdf: string | null = null;
let zoom: number | "fit" = "fit";
let renderedScale = 1; // what "fit" resolved to on the last render
let renderToken = 0;

export function setStatus(text: string, kind: "ok" | "busy" | "fail" | "info" | "" = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

/** Show a PDF; re-renders only when the URL changes (it carries a version). */
export function showPdf(url: string, { stale = false } = {}) {
  viewer.classList.toggle("stale", stale);
  if (url === currentPdf) return;
  currentPdf = url;
  render();
}

export function showMessage(html: string) {
  reset();
  const p = document.createElement("p");
  p.className = "message";
  p.innerHTML = html;
  viewer.replaceChildren(p);
}

export async function showText(url: string) {
  reset();
  const token = renderToken;
  const text = await (await fetch(url)).text();
  if (token !== renderToken) return;
  const pre = document.createElement("pre");
  pre.className = "source";
  pre.textContent = text;
  const { scrollTop } = viewer;
  viewer.replaceChildren(pre);
  viewer.scrollTop = scrollTop;
}

export function showImage(url: string) {
  reset();
  const img = document.createElement("img");
  img.className = "image";
  img.src = url;
  viewer.replaceChildren(img);
}

function reset() {
  currentPdf = null;
  renderToken++;
  viewer.classList.remove("stale");
}

/** Render every page off-screen, then swap in one step so the preview never flickers or loses scroll. */
async function render() {
  if (!currentPdf) return;
  const token = ++renderToken;
  const task = pdfjs.getDocument({ url: currentPdf });
  try {
    const pdf = await task.promise;
    const pagesEl = document.createElement("div");
    pagesEl.className = "pages";
    const dpr = window.devicePixelRatio || 1;
    const available = viewer.clientWidth - 48;

    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const scale = zoom === "fit" ? available / page.getViewport({ scale: 1 }).width : zoom;
      if (n === 1) renderedScale = scale;
      const viewport = page.getViewport({ scale: scale * dpr });
      const canvas = document.createElement("canvas");
      canvas.className = "page";
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
      await page.render({ canvas, viewport }).promise;
      if (token !== renderToken) return;
      pagesEl.append(canvas);
    }

    const { scrollTop, scrollLeft } = viewer;
    viewer.replaceChildren(pagesEl);
    viewer.scrollTop = scrollTop;
    viewer.scrollLeft = scrollLeft;
  } catch (err) {
    if (token === renderToken) showMessage(`Couldn't render this PDF.<br><small>${String(err).replace(/</g, "&lt;")}</small>`);
  } finally {
    task.destroy();
  }
}

/** Re-render at the current width (after a pane resize, for example). */
export function refit() {
  if (currentPdf && zoom === "fit") render();
}

// ---------- zoom ----------

const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

function stepZoom(dir: 1 | -1) {
  const now = zoom === "fit" ? renderedScale : zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((z) => z > now + 0.01) : [...ZOOM_STEPS].reverse().find((z) => z < now - 0.01);
  if (next === undefined) return;
  zoom = next;
  render();
}

$("zoom-in").onclick = () => stepZoom(1);
$("zoom-out").onclick = () => stepZoom(-1);
$("zoom-fit").onclick = () => {
  zoom = "fit";
  render();
};

new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(refit, 150);
}).observe(viewer);
let resizeTimer: ReturnType<typeof setTimeout>;

// ---------- logs ----------

logsButton.onclick = () => (logs.hidden = !logs.hidden);

export function showLogsButton(visible: boolean) {
  logsButton.hidden = !visible;
  if (!visible) logs.hidden = true;
}

export function openLogs() {
  logs.hidden = false;
}

export function showDiagnostics(list: Diagnostic[]) {
  const errors = list.filter((d) => d.severity === "error").length;
  logsButton.textContent = list.length ? `Logs (${list.length})` : "Logs";
  logsButton.classList.toggle("has-errors", errors > 0);

  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = "No errors or warnings.";
    diagnosticsEl.replaceChildren(li);
    return;
  }
  // Errors first; they're what stops the build.
  const sorted = [...list].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  diagnosticsEl.replaceChildren(
    ...sorted.map((d) => {
      const li = document.createElement("li");
      li.className = d.severity;
      const where = document.createElement("span");
      where.className = "where";
      where.textContent = `${d.severity}${d.file ? ` · ${d.file}` : ""}${d.line ? `:${d.line}` : ""}`;
      const msg = document.createElement("span");
      msg.className = "msg";
      msg.textContent = d.message;
      li.append(where, msg);
      return li;
    }),
  );
}
