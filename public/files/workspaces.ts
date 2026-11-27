import { API, type ImportRequest, type NewProjectRequest, type OpenWorkspaceResponse, type PickFolderResponse } from "../../shared/protocol";
import { toggleMenu, type MenuItem } from "../ui/menu";
import { openPalette } from "../ui/palette";
import { askText } from "../ui/ask";
import { state } from "../core/state";
import { $, toast } from "../core/util";

/**
 * Projects: the title bar names the open project and switches between projects. underleaf keeps them
 * in its own folder (the library), so nobody picks folders: New project… names one, Import folder…
 * copies an existing one in. Opening one makes the server swap everything (files, history, Claude);
 * every tab then reloads into it.
 */

const button = $<HTMLButtonElement>("workspace-btn");
// Menu values that can't be a path.
const NEW = "\u0000new";
const IMPORT = "\u0000import";
const RENAME = "\u0000rename";
const REVEAL = "\u0000reveal";

const short = (dir: string) => dir.replace(/^\/(?:Users|home)\/[^/]+/, "~");
const fileManager = navigator.platform.startsWith("Mac") ? "Finder" : navigator.platform.startsWith("Win") ? "Explorer" : "your file manager";

export function initWorkspaces() {
  button.onclick = () => {
    const ws = state.workspace;
    if (!ws) return;
    const items: MenuItem[] = [
      ...ws.projects.map((p) => ({ value: p.dir, label: p.name, icon: p.dir === ws.dir ? "●" : "", kind: p.dir === ws.dir ? "current" : undefined })),
      { value: NEW, label: "New project…", meta: "Start from a template", icon: "+" },
      { value: IMPORT, label: "Import folder…", meta: "Copy a LaTeX project in", icon: "↓" },
      ...(ws.inLibrary ? [{ value: RENAME, label: `Rename "${ws.name}"…`, icon: "✎" }] : []),
      { value: REVEAL, label: `Show files in ${fileManager}`, icon: "↗" },
    ];
    toggleMenu(button, items, ws.dir, (value) => {
      if (value === NEW) return void newProject();
      if (value === IMPORT) return void importFolder();
      if (value === RENAME) return void renameProject();
      if (value === REVEAL) return void showFiles();
      void switchTo(value);
    });
  };
}

/** The title bar: the project's name (its folder is in the tooltip). */
export function showWorkspace() {
  const ws = state.workspace;
  if (!ws) return;
  button.querySelector(".ws-name")!.textContent = ws.name;
  button.dataset.tip = `${ws.inLibrary ? ws.name : short(ws.dir)} · switch project`;
  document.title = `${ws.name} · underleaf`;
}

const post = async <T>(path: string, body?: unknown): Promise<T | null> =>
  (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }).catch(() => null))
    ?.json()
    .catch(() => null) as Promise<T | null>;

export async function switchTo(dir: string) {
  if (dir === state.workspace?.dir) return;
  const body = await post<OpenWorkspaceResponse>(API.workspaceOpen, { dir });
  if (!body || "error" in body) toast(body && "error" in body ? body.error : "Couldn't open that project");
  // On success the server tells every tab, and each reloads into the new project.
}

/** New project…: a name, then an empty project that offers the templates. */
export async function newProject() {
  const name = await askText({ heading: "New project", value: "", confirm: "Create" });
  if (!name) return;
  const request: NewProjectRequest = { name };
  const body = await post<OpenWorkspaceResponse>(API.projectNew, request);
  if (!body || "error" in body) toast(body && "error" in body ? body.error : "Couldn't create the project");
}

export async function renameProject() {
  const ws = state.workspace;
  if (!ws?.inLibrary) return;
  const name = await askText({ heading: "Rename project", value: ws.name, confirm: "Rename" });
  if (!name || name === ws.name) return;
  const request: NewProjectRequest = { name };
  const body = await post<OpenWorkspaceResponse>(API.projectRename, request);
  if (!body || "error" in body) toast(body && "error" in body ? body.error : "Couldn't rename the project");
}

/** Import folder…: the system's folder dialog (shown by the server); the folder is copied in, never changed. */
export async function importFolder() {
  toast("Choose a folder to copy in…");
  const request: ImportRequest = {};
  const body = await post<PickFolderResponse>(API.projectImport, request);
  if (!body) return toast("Couldn't open the folder dialog");
  if ("error" in body) return toast(body.error);
  if ("cancelled" in body) return toast("No folder chosen");
}

export async function showFiles() {
  await post(API.projectReveal);
}

/** Palette: jump to another project. */
export function switchWorkspacePalette() {
  const ws = state.workspace;
  if (!ws) return;
  openPalette({
    placeholder: "Switch project…",
    items: [
      ...ws.projects.filter((p) => p.dir !== ws.dir).map((p) => ({ label: p.name, run: () => switchTo(p.dir) })),
      { label: "New project…", run: newProject },
    ],
  });
}
