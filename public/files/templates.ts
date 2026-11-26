import * as preview from "../preview/preview";
import { toast } from "../core/util";
import { API, type StartTemplateRequest, type StartTemplateResponse, type TemplatesResponse } from "../../shared/protocol";
import { open, tree } from "./open";

/**
 * An empty folder (no .tex files) offers the templates in the preview: resume, thesis, article,
 * blank. Starting one copies its files in, gives Claude its instructions, and opens the document.
 */
export async function showTemplates() {
  const res = (await fetch(API.templates)
    .then((r) => r.json())
    .catch(() => null)) as TemplatesResponse | null;
  if (!res?.canStart) return preview.showMessage("Pick a file on the left, or ask Claude to create a <code>.tex</code> file here.");
  const { templates } = res;

  const box = document.createElement("section");
  box.className = "templates";
  const heading = document.createElement("h2");
  heading.textContent = "Start a document";
  const intro = document.createElement("p");
  intro.textContent = "This folder has no LaTeX files yet. Pick a starting point: Claude gets instructions for that kind of document. Nothing already here is changed.";
  const list = document.createElement("div");
  list.className = "template-list";
  for (const t of templates) {
    const card = document.createElement("button");
    card.className = "template-card";
    card.dataset.template = t.name;
    const title = document.createElement("strong");
    title.textContent = t.title;
    const description = document.createElement("span");
    description.textContent = t.description;
    card.append(title, description);
    card.onclick = () => start(t.name, list);
    list.append(card);
  }
  box.append(heading, intro, list);
  preview.showElement(box);
  (list.querySelector("button") as HTMLButtonElement | null)?.focus({ preventScroll: true });
}

async function start(name: string, list: HTMLElement) {
  for (const b of list.querySelectorAll("button")) b.disabled = true;
  const body: StartTemplateRequest = { name };
  const res = (await fetch(API.templateStart, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json())
    .catch(() => ({ error: "Couldn't reach underleaf" }))) as StartTemplateResponse;
  if ("error" in res) {
    toast(res.error);
    for (const b of list.querySelectorAll("button")) b.disabled = false;
    return;
  }
  // The server sends the new tree before it answers; wait briefly in case it's still in flight.
  for (let i = 0; i < 20; i++) {
    const file = tree.find(res.open);
    if (file) return open(file);
    await new Promise((r) => setTimeout(r, 100));
  }
}
