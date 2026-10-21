/**
 * End-to-end smoke test: a scratch workspace with history, the real server, and headless
 * Chrome driven over the DevTools protocol. Run before and after refactors.
 *
 *   bun run smoke            # needs Google Chrome (or set CHROME=/path/to/chrome)
 *   bun run smoke --keep     # leave the scratch folder for a look afterwards
 *
 * Claude is replaced by a stand-in script, so this never starts your real `claude`.
 */
import os from "node:os";
import path from "node:path";
import { chmod, cp, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { REPO } from "../src/repo";
import { API, url } from "../shared/protocol";

const KEEP = process.argv.includes("--keep");
const MOD = process.platform === "darwin" ? "Meta" : "Control";

// ---------- setup ----------

const chrome =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find((p) => Bun.file(p).size > 0) ??
  Bun.which("google-chrome") ??
  Bun.which("chromium") ??
  Bun.which("chromium-browser");
if (!chrome) {
  console.error("smoke: Chrome not found. Install Google Chrome or set CHROME=/path/to/chrome.");
  process.exit(1);
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "underleaf-smoke-"));
const latex = path.join(tmp, "latex");
const other = path.join(tmp, "other"); // a second workspace to switch to
const downloads = path.join(tmp, "downloads");
const home = path.join(tmp, "home");
await mkdir(latex, { recursive: true });
await mkdir(path.join(latex, "memory"), { recursive: true });
await mkdir(other, { recursive: true });
await mkdir(downloads, { recursive: true });
// Agent files, as a resume workspace has them (folders you open don't get them added).
await Bun.write(path.join(latex, "CLAUDE.md"), "# Claude\n");
await Bun.write(path.join(latex, "memory", "profile.md"), "# Profile\n");
await Bun.write(path.join(other, "other.tex"), "\\documentclass{article}\n\\begin{document}\nThe other workspace.\n\\end{document}\n");
const main = path.join(latex, "main.tex");
await cp(path.join(REPO, "templates", "resume.tex"), main);
await Bun.write(path.join(latex, "notes.md"), "# notes\n\n- first\n");

// A stand-in for the Claude Code CLI: notes the hook token it was given, prints a line, then echoes input.
const fakeClaude = path.join(tmp, "fake-claude");
const tokenFile = path.join(tmp, "hook-token");
await Bun.write(fakeClaude, `#!/bin/sh\nprintf '%s' "$UNDERLEAF_HOOK_TOKEN" > '${tokenFile}'\necho "fake claude ready in $(basename "$PWD")"\nexec cat\n`);
await chmod(fakeClaude, 0o755);

// History with a few versions: init → two edits. history.ts reads UNDERLEAF_HOME when it's
// loaded, so set it first and import afterwards (never touch the real ~/.underleaf).
process.env.UNDERLEAF_HOME = home;
const { HistoryStore, editLabel } = await import("../src/history/store");
const store = (await HistoryStore.open(latex))!;
const replace = async (from: string, to: string) => {
  const text = await Bun.file(main).text();
  if (!text.includes(from)) throw new Error(`smoke setup: "${from}" not in the template`);
  await Bun.write(main, text.replace(from, to));
};
await replace("Owned the order-status service", "Led the order-status service");
await store.snapshot({ kind: "edit", author: "You", label: (c) => editLabel(c) });
await replace("Reduced p99 latency", "Cut p99 latency");
await store.snapshot({ kind: "claude", author: "Claude", label: "Claude: Tighten the bullets" });

const port = freePort();
const debugPort = freePort();
const server = Bun.spawn(["bun", path.join(REPO, "src/server.ts"), latex, "--port", String(port), "--no-open"], {
  env: { ...process.env, UNDERLEAF_HOME: home, UNDERLEAF_CLAUDE_BIN: fakeClaude },
  stdout: "pipe",
  stderr: "pipe",
});
const serverLog: string[] = [];
collect(server.stdout, serverLog);
collect(server.stderr, serverLog);

const browser = Bun.spawn(
  [chrome, "--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(tmp, "chrome")}`, "--no-first-run", "--no-default-browser-check", "about:blank"],
  { stdout: "ignore", stderr: "ignore" },
);

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  server.kill();
  browser.kill();
  await Promise.all([server.exited, browser.exited]);
  if (KEEP) console.log(`\nscratch kept at ${tmp}`);
  else await rm(tmp, { recursive: true, force: true });
}

// Leave nothing running if the test itself breaks.
process.on("uncaughtException", async (e) => {
  console.error(`\nsmoke: ${e.message}\n${serverLog.slice(-15).join("\n")}`);
  await cleanup();
  process.exit(1);
});
process.on("unhandledRejection", (e) => process.emit("uncaughtException", e as Error));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => cleanup().then(() => process.exit(130)));

// ---------- DevTools client ----------

await until(() => serverLog.some((l) => l.includes("underleaf →")), 20_000, "server start");
const cdp = await connect(debugPort);
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 2, mobile: false });
const pageErrors: string[] = [];
cdp.on("Runtime.exceptionThrown", (p) => pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));

const js = async <T = unknown>(expression: string): Promise<T> => {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value as T;
};
const waitFor = (expression: string, what: string, ms = 10_000) => until(async () => !!(await js(expression)), ms, what);
const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const status = () => js<string>("document.getElementById('status').textContent");

async function press(key: string, modifiers: string[] = []) {
  const bits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as Record<string, number>;
  let mods = modifiers.reduce((m, k) => m | bits[k]!, 0);
  if (/^[A-Z]$/.test(key)) mods |= 8;
  const code =
    { Escape: "Escape", Enter: "Enter", ",": "Comma", ".": "Period", "]": "BracketRight", "[": "BracketLeft", "+": "Equal", "=": "Equal" }[key] ??
    (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key);
  const vk = { Escape: 27, Enter: 13, ",": 188, ".": 190, "]": 221, "[": 219 }[key] ?? key.toUpperCase().charCodeAt(0);
  const printable = key.length === 1 && !(mods & 6);
  await cdp.send("Input.dispatchKeyEvent", { type: printable ? "keyDown" : "rawKeyDown", key, code, modifiers: mods, text: printable ? key : undefined, windowsVirtualKeyCode: vk });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers: mods, windowsVirtualKeyCode: vk });
  await Bun.sleep(40);
}
const focusPreview = () => js("document.getElementById('preview-pane').focus()");

// ---------- checks ----------

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  const t0 = performance.now();
  try {
    await fn();
    console.log(`  ✓ ${name}  \x1b[2m${Math.round(performance.now() - t0)}ms\x1b[0m`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}
function expect(ok: unknown, message: string) {
  if (!ok) throw new Error(message);
}

console.log(`underleaf smoke test  (${tmp})\n`);

await check("every element id the code looks up exists in index.html", async () => {
  const html = await Bun.file(path.join(REPO, "public", "index.html")).text();
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
  const missing: string[] = [];
  for await (const file of new Bun.Glob("public/**/*.ts").scan({ cwd: REPO })) {
    const code = await Bun.file(path.join(REPO, file)).text();
    for (const m of code.matchAll(/\$(?:<[^>]+>)?\("([\w-]+)"\)|getElementById\("([\w-]+)"\)/g)) {
      const id = (m[1] ?? m[2])!;
      if (!ids.has(id)) missing.push(`${id} (${file})`);
    }
  }
  expect(missing.length === 0, `not in index.html: ${missing.join(", ")}`);
});

await cdp.send("Page.navigate", { url: `http://localhost:${port}/#latex/main.tex` });

await check("opens and compiles the document", async () => {
  await waitFor("document.querySelectorAll('#viewer canvas.page').length > 0", "first PDF page", 20_000);
  await waitFor("document.getElementById('status').textContent.startsWith('Built')", "the Built status", 20_000); // a background build may still be finishing
  const files = await js<string>("[...document.querySelectorAll('#tree .row .name')].map(n => n.textContent).join(',')");
  expect(files.includes("main.tex") && files.includes("notes.md"), `tree: ${files}`);
});

await check("zoom menu: a preset changes the zoom and its label", async () => {
  await click("#zoom-menu-btn");
  await waitFor("!document.getElementById('zoom-menu').hidden", "zoom menu");
  await click("[data-zoom='1.5']");
  await waitFor("document.getElementById('zoom-label').textContent === '150%' && document.getElementById('zoom-menu').hidden", "150% and menu closed");
  await click("#zoom-menu-btn");
  await click("#zoom-fit");
  await waitFor("document.getElementById('zoom-label').textContent === 'Fit'", "back to Fit");
});

await check("a shortcut closes an open menu, and keys work right after", async () => {
  await click("#zoom-menu-btn");
  await waitFor("!document.getElementById('zoom-menu').hidden", "zoom menu");
  await press("p", [MOD]);
  await waitFor("document.getElementById('zoom-menu').hidden && !document.getElementById('palette').hidden", "menu closed, palette open");
  await press("Escape");
  await waitFor("document.getElementById('palette').hidden", "palette closed");
  await focusPreview();
  await press("+");
  await waitFor("document.getElementById('zoom-label').textContent !== 'Fit'", "+ zoomed in");
  await press("=");
  await waitFor("document.getElementById('zoom-label').textContent === 'Fit'", "= back to Fit");
});

await check("agent files: hidden by default, one click shows them", async () => {
  await waitFor("/\\d+ agent files hidden/.test(document.getElementById('tree-foot').textContent)", "the hidden-files line");
  await click("#agent-toggle");
  await waitFor("[...document.querySelectorAll('#tree .row .name')].some(n => n.textContent === 'CLAUDE.md')", "CLAUDE.md listed");
  await click("#agent-toggle");
  await waitFor("![...document.querySelectorAll('#tree .row .name')].some(n => n.textContent === 'CLAUDE.md')", "hidden again");
});

await check("Claude pane runs the CLI in a terminal", async () => {
  await waitFor("document.querySelector('#terminal .xterm-rows')?.textContent.includes('fake claude ready')", "terminal output");
});

await check("version bar lists the history", async () => {
  await waitFor("document.querySelectorAll('#version-track .vdot').length >= 4", "version dots"); // 3 snapshots + Now
});

await check("views an earlier version, Esc goes back", async () => {
  await click("#version-track .vdot");
  await waitFor("!document.getElementById('snapshot-banner').hidden", "banner");
  await waitFor("document.getElementById('status').className.includes('info')", "compiled old version", 20_000);
  await focusPreview();
  await press("Escape");
  await waitFor("document.getElementById('snapshot-banner').hidden", "banner closed");
});

await check("⋯ menu: lists what applies, and runs it (compare)", async () => {
  await click("#more-btn");
  await waitFor("!document.getElementById('more-menu').hidden", "more menu");
  const items = await js<string>("[...document.querySelectorAll('#more-menu [role=menuitem]')].filter(i => !i.hidden).map(i => i.textContent.trim()).join(' | ')");
  expect(items.includes("Compare with previous version") && items.includes("Hide version bar"), `items: ${items}`);
  await click("#more-menu [data-command='compare-previous']");
  await waitFor("!document.getElementById('compare-bar').hidden && /change/i.test(document.getElementById('compare-status').textContent)", "comparison from the menu", 20_000);
  await press("Escape");
  await waitFor("document.getElementById('compare-bar').hidden", "comparison closed");
});

await check("compares with the previous version (C)", async () => {
  await focusPreview();
  await press("C");
  await waitFor("!document.getElementById('compare-bar').hidden && /change/.test(document.getElementById('status').textContent)", "comparison", 20_000);
  const marks = await js<number>("document.querySelectorAll('#diff .hl.add, #diff .hl.del').length");
  expect(marks > 0, "no highlights");
});

await check("picker menu opens, filters, Esc closes only the menu", async () => {
  await click("#compare-a");
  await waitFor("document.querySelectorAll('.menu li').length >= 4", "menu items");
  await press("Escape");
  await waitFor("!document.querySelector('.menu')", "menu closed");
  expect(!(await js<boolean>("document.getElementById('compare-bar').hidden")), "comparison closed too");
});

await check("source view (S), then Esc closes the comparison", async () => {
  await focusPreview();
  await press("S");
  await waitFor("document.querySelectorAll('#diff .src-row.add').length > 0", "source rows");
  await press("Escape");
  await waitFor("document.getElementById('compare-bar').hidden && !document.getElementById('viewer').hidden", "comparison closed");
});

await check("live edit recompiles and shows in a comparison", async () => {
  const builds = () => serverLog.filter((l) => l.startsWith("✓ main.tex")).length;
  const before = builds();
  await replace("Built an internal load-testing tool", "Built a distributed load-testing tool");
  await until(() => builds() > before, 20_000, "a rebuild after the edit");
  await waitFor("document.getElementById('status').textContent.startsWith('Built')", "built status");
  await focusPreview();
  await press("C");
  await waitFor("/change/.test(document.getElementById('status').textContent) && !document.getElementById('compare-bar').hidden", "comparison", 20_000);
  await press("Escape");
});

await check("restores an earlier version (two clicks), file changes on disk", async () => {
  await click("#version-track .vdot"); // the oldest
  await waitFor("!document.getElementById('snapshot-banner').hidden", "banner");
  await click("#snapshot-restore");
  await click("#snapshot-restore");
  await until(async () => (await Bun.file(main).text()).includes("Owned the order-status service"), 10_000, "restored text on disk");
});

await check("Save PDF (mod+S) asks where once, then saves over that file", async () => {
  await waitFor("document.getElementById('status').textContent.startsWith('Built')", "built", 20_000);
  // Stand in for the system save dialog: count dialogs and writes, and keep the first bytes written.
  await js(`window.__save = { picks: 0, writes: 0, head: "" };
    window.showSaveFilePicker = async () => {
      window.__save.picks++;
      return { name: "draft.pdf", kind: "file", queryPermission: async () => "granted",
        createWritable: async () => ({ write: async (b) => { window.__save.head = await b.slice(0, 4).text(); }, close: async () => { window.__save.writes++; } }) };
    }`);
  await press("s", [MOD]);
  await waitFor("window.__save.writes === 1 && window.__save.picks === 1 && window.__save.head === '%PDF'", "first save, through the dialog");
  await press("s", [MOD]);
  await waitFor("window.__save.writes === 2", "second save");
  expect((await js<number>("window.__save.picks")) === 1, "asked where a second time");
  await click("#save-more");
  await waitFor("!document.getElementById('save-menu').hidden && document.getElementById('save-again-name').textContent === 'draft.pdf'", "Save again names the file");
  await press("Escape");
});

await check("Save to Downloads downloads the PDF", async () => {
  await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await click("#save-more");
  await click("#save-menu [data-command='save-downloads']");
  await until(async () => (await Bun.file(path.join(downloads, "main.pdf")).exists()), 10_000, "main.pdf in Downloads");
});

await check("quick open (mod+P) lists files and opens one", async () => {
  await press("p", [MOD]);
  await waitFor("!document.getElementById('palette').hidden", "palette");
  await cdp.send("Input.insertText", { text: "notes" });
  await press("Enter");
  await waitFor("document.getElementById('preview-title').textContent === 'latex/notes.md'", "notes.md open");
});

await check("? opens the cheat sheet with every section", async () => {
  await focusPreview();
  await press("?");
  await waitFor("!document.getElementById('cheatsheet').hidden", "cheat sheet");
  const text = await js<string>("document.getElementById('cheatsheet-body').textContent");
  for (const want of ["Anywhere", "Files", "Preview", "Compare with previous version", "Go to file"]) expect(text.includes(want), `missing "${want}"`);
  await press("Escape");
  await waitFor("document.getElementById('cheatsheet').hidden", "cheat sheet closed");
});

await check("command palette (mod+shift+P) runs a command", async () => {
  await press("p", [MOD, "Shift"]);
  await waitFor("!document.getElementById('palette').hidden", "palette");
  await cdp.send("Input.insertText", { text: "toggle version bar" });
  const before = await js<boolean>("document.getElementById('version-strip').hidden");
  await press("Enter");
  await waitFor(`document.getElementById('version-strip').hidden === ${!before}`, "version bar toggled");
});

await check("Claude hooks: a turn becomes one labelled snapshot; a wrong token is refused", async () => {
  const token = await Bun.file(tokenFile).text();
  const hook = (event: string, body: object, t = token) =>
    fetch(`http://localhost:${port}${url(API.claudeHook, { event })}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Underleaf-Token": t },
      body: JSON.stringify(body),
    });
  expect((await hook("prompt", { prompt: "x" }, "wrong")).status === 403, "wrong token accepted");
  expect((await hook("prompt", { prompt: "Make the summary punchier" })).status === 204, "prompt hook failed");
  await replace("Comfortable across the stack", "At home across the stack");
  await Bun.sleep(400);
  expect((await hook("stop", {})).status === 204, "stop hook failed");
  const labels = async () =>
    ((await (await fetch(`http://localhost:${port}${url(API.history, { path: "latex/main.tex" })}`)).json()) as { snapshots: { label: string }[] }).snapshots.map((s) => s.label);
  await until(async () => (await labels()).includes("Claude: Make the summary punchier"), 10_000, "Claude snapshot");
  // Two ⌘S and a download with nothing changed in between: one marker, not three.
  const saves = (await labels()).filter((l) => l.startsWith("Saved as") || l.startsWith("Downloaded"));
  expect(saves.length === 1 && saves[0] === "Saved as draft.pdf", `save markers: ${saves.join(" | ") || "none"}`);
});

await check("saving after a change leaves a new marker", async () => {
  // Quick open moved to notes.md; back to main.tex, which the hooks check above changed since the last save.
  await press("p", [MOD]);
  await waitFor("!document.getElementById('palette').hidden", "palette");
  await cdp.send("Input.insertText", { text: "main.tex" });
  await press("Enter");
  await waitFor("document.getElementById('preview-title').textContent === 'latex/main.tex' && document.getElementById('status').textContent.startsWith('Built')", "main.tex built", 20_000);
  await press("s", [MOD]);
  const saveMarkers = async () =>
    ((await (await fetch(`http://localhost:${port}${url(API.history, { path: "latex/main.tex" })}`)).json()) as { snapshots: { label: string }[] }).snapshots.filter((s) => s.label === "Saved as draft.pdf").length;
  await until(async () => (await saveMarkers()) === 2, 10_000, "a second save marker");
  // Leave notes.md open: the workspace-switch checks expect it back as the last open file.
  await press("p", [MOD]);
  await waitFor("!document.getElementById('palette').hidden", "palette");
  await cdp.send("Input.insertText", { text: "notes" });
  await press("Enter");
  await waitFor("document.getElementById('preview-title').textContent === 'latex/notes.md'", "notes.md open");
});

const openFolder = (dir: string) =>
  fetch(`http://localhost:${port}${API.workspaceOpen}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir }) });

await check("refuses folders inside underleaf's checkout, without writing to them", async () => {
  const templates = path.join(REPO, "templates", "workspace");
  const res = await openFolder(templates);
  expect(res.status === 400, `templates/workspace: status ${res.status}`);
  expect(!(await Bun.file(path.join(templates, ".underleaf", "id")).exists()), "an id was written into the template");
});

await check("a folder that can't be opened leaves the current workspace running", async () => {
  const locked = path.join(tmp, "locked");
  await mkdir(locked);
  await Bun.write(path.join(locked, "x.tex"), "\\documentclass{article}\n\\begin{document}x\\end{document}\n");
  await chmod(locked, 0o555);
  try {
    const res = await openFolder(locked);
    const body = (await res.json()) as { error?: string };
    expect(res.status === 400 && /can't write/.test(body.error ?? ""), `read-only folder: ${res.status} ${body.error}`);
  } finally {
    await chmod(locked, 0o755);
  }
  // The old workspace still watches its files: a new one shows up in the tree.
  await Bun.write(path.join(latex, "after-refusal.md"), "still here\n");
  await waitFor("[...document.querySelectorAll('#tree .row .name')].some(n => n.textContent === 'after-refusal.md')", "new file listed", 10_000);
});

await check("switching workspaces swaps the files, the title and Claude's folder", async () => {
  await js(`fetch("/api/workspace/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir: ${JSON.stringify(other)} }) })`);
  await waitFor("[...document.querySelectorAll('#tree .row .name')].some(n => n.textContent === 'other.tex')", "the other workspace's files", 20_000);
  await waitFor("document.querySelector('#workspace-btn .ws-name').textContent === 'other'", "title bar names it");
  expect(!(await js<boolean>("[...document.querySelectorAll('#tree .row .name')].some(n => n.textContent === 'main.tex')")), "old files still listed");
  await waitFor("document.querySelector('#terminal .xterm-rows')?.textContent.includes('fake claude ready in other')", "Claude restarted in the other folder");
});

await check("switching back from the title bar restores that workspace's history and open file", async () => {
  await click("#workspace-btn");
  await waitFor("[...document.querySelectorAll('.menu li .label')].some(l => l.textContent === 'latex')", "recent workspaces listed");
  await js("[...document.querySelectorAll('.menu li')].find(li => li.querySelector('.label')?.textContent === 'latex').click()");
  await waitFor("[...document.querySelectorAll('#tree .row .name')].some(n => n.textContent === 'main.tex')", "back in the first workspace", 20_000);
  await waitFor("document.getElementById('preview-title').textContent === 'latex/notes.md'", "its last open file (notes.md) reopened");
});

await check("a workspace folder that disappears isn't recreated", async () => {
  const doomed = path.join(tmp, "doomed");
  await mkdir(doomed);
  await Bun.write(path.join(doomed, "d.tex"), "\\documentclass{article}\n\\begin{document}d\\end{document}\n");
  expect((await openFolder(doomed)).status === 200, "couldn't open the folder");
  await waitFor("[...document.querySelectorAll('#tree .row .name')].some(n => n.textContent === 'd.tex')", "its files", 20_000);
  await rename(doomed, path.join(tmp, "doomed-moved")); // as if moved to the trash
  await waitFor("![...document.querySelectorAll('#tree .row .name')].some(n => n.textContent === 'd.tex')", "files gone from the tree", 10_000);
  await Bun.sleep(1500); // past the 1 s health check (and the brief's debounce)
  expect(!(await Bun.file(doomed).exists()) && !(await stat(doomed).catch(() => null)), "the folder was recreated");
});

await check("no errors in the page", async () => {
  expect(pageErrors.length === 0, pageErrors.join("\n      "));
});

await cleanup();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
if (failed && !KEEP) console.log("(re-run with --keep to inspect the scratch workspace)");
process.exit(failed ? 1 : 0);

// ---------- helpers ----------

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

async function until(fn: () => boolean | Promise<boolean>, ms: number, what: string) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (await Promise.resolve().then(fn).catch(() => false)) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function collect(stream: ReadableStream<Uint8Array>, into: string[]) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) into.push(...decoder.decode(chunk).split("\n"));
}

type Cdp = { send: (method: string, params?: object) => Promise<any>; on: (event: string, fn: (params: any) => void) => void };

async function connect(port: number): Promise<Cdp> {
  let pages: { type: string; webSocketDebuggerUrl: string }[] = [];
  await until(async () => {
    pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    return pages.some((p) => p.type === "page");
  }, 15_000, "Chrome");
  const ws = new WebSocket(pages.find((p) => p.type === "page")!.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const listeners = new Map<string, ((p: any) => void)[]>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id) pending.get(m.id)?.(m.result ?? m);
    else listeners.get(m.method)?.forEach((fn) => fn(m.params));
  };
  return {
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const i = ++id;
        pending.set(i, resolve);
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
    on: (event, fn) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
  };
}
