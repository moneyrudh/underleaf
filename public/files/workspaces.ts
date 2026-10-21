import { API, type OpenWorkspaceResponse, type PickFolderResponse } from "../../shared/protocol";
import { toggleMenu, type MenuItem } from "../ui/menu";
import { openPalette } from "../ui/palette";
import { state } from "../core/state";
import { $, toast } from "../core/util";

/**
 * Workspaces: the title bar names the open folder and switches between folders. Opening one makes
 * the server swap everything (files, history, Claude); every tab then reloads into it.
 */

const button = $<HTMLButtonElement>("workspace-btn");
const OPEN_FOLDER = "\u0000open"; // menu value that can't be a path

const short = (dir: string) => dir.replace(/^\/(?:Users|home)\/[^/]+/, "~");

export function initWorkspaces() {
  button.onclick = () => {
    const ws = state.workspace;
    if (!ws) return;
    const items: MenuItem[] = [
      ...ws.recent.map((r) => ({ value: r.dir, label: r.name, meta: short(r.dir), icon: r.dir === ws.dir ? "●" : "", kind: r.dir === ws.dir ? "current" : undefined })),
      { value: OPEN_FOLDER, label: "Open folder…", meta: "Pick any folder with your documents", icon: "+" },
    ];
    toggleMenu(button, items, ws.dir, (value) => (value === OPEN_FOLDER ? openFolder() : switchTo(value)));
  };
}

/** The title bar: the folder's name, with its path beside it. */
export function showWorkspace() {
  const ws = state.workspace;
  if (!ws) return;
  button.querySelector(".ws-name")!.textContent = ws.name;
  button.querySelector(".ws-path")!.textContent = short(ws.dir);
  button.dataset.tip = `${short(ws.dir)} · switch workspace`;
  document.title = `${ws.name} · underleaf`;
  $("claude-where").textContent = ws.name;
}

export async function switchTo(dir: string) {
  if (dir === state.workspace?.dir) return;
  toast(`Opening ${short(dir)}…`);
  const res = await fetch(API.workspaceOpen, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir }) }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as OpenWorkspaceResponse | null;
  if (!body || "error" in body) toast(body && "error" in body ? body.error : "Couldn't open that folder");
  // On success the server tells every tab, and each reloads into the new workspace.
}

/** Open folder…: the system's folder dialog, shown by the server. */
export async function openFolder() {
  toast("Choose a folder in the dialog…");
  const res = await fetch(API.workspacePick, { method: "POST" }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as PickFolderResponse | null;
  if (!body) return toast("Couldn't open the folder dialog");
  if ("error" in body) return toast(body.error);
  if ("cancelled" in body) return toast("No folder chosen");
}

/** Palette: jump to a recent workspace. */
export function switchWorkspacePalette() {
  const ws = state.workspace;
  if (!ws) return;
  openPalette({
    placeholder: "Switch workspace…",
    items: [
      ...ws.recent.filter((r) => r.dir !== ws.dir).map((r) => ({ label: `${r.name}  ${short(r.dir)}`, run: () => switchTo(r.dir) })),
      { label: "Open folder…", run: openFolder },
    ],
  });
}
