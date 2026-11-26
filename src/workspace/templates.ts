import path from "node:path";
import { stat } from "node:fs/promises";
import { REPO } from "../repo";
import type { TemplateInfo } from "../../shared/types";

/**
 * Starting points for a workspace: templates/<name>/ holds
 *   template.json      title, description, the file to open first, shared skills to include
 *   files/             copied into the workspace once, never over an existing file
 *   instructions.md    (optional) notes for Claude about this kind of document; underleaf-owned
 * templates/instructions.md is the part every workspace gets; templates/_skills/ holds skills
 * that more than one template uses.
 *
 * A workspace's template is recorded in .underleaf/template. Its instructions for Claude
 * (.underleaf/instructions.md) are the shared part plus the template's notes, rewritten on every
 * start, so they follow underleaf updates. The user's own instructions live in CLAUDE.md.
 */

const TEMPLATES = path.join(REPO, "templates");
const ORDER = ["resume", "thesis", "article", "blank"];

type Manifest = { title: string; description: string; open: string; skills?: string[] };

const manifest = async (name: string): Promise<Manifest | null> =>
  Bun.file(path.join(TEMPLATES, name, "template.json"))
    .json()
    .catch(() => null);

export async function listTemplates(): Promise<TemplateInfo[]> {
  const out: TemplateInfo[] = [];
  for (const name of ORDER) {
    const m = await manifest(name);
    if (m) out.push({ name, title: m.title, description: m.description });
  }
  return out;
}

const exists = (file: string) => stat(file).then(() => true, () => false);

/**
 * Copy a template into `dir`, skipping any file that's already there, and record it.
 * Returns the path (relative to `dir`) of the document to open first.
 */
export async function applyTemplate(dir: string, name: string): Promise<string> {
  const m = ORDER.includes(name) ? await manifest(name) : null;
  if (!m) throw new Error(`no template named "${name}"`);
  const copies: [from: string, to: string][] = [];
  const files = path.join(TEMPLATES, name, "files");
  for await (const rel of new Bun.Glob("**/*").scan({ cwd: files, dot: true })) copies.push([path.join(files, rel), rel]);
  for (const skill of m.skills ?? []) {
    const from = path.join(TEMPLATES, "_skills", skill);
    for await (const rel of new Bun.Glob("**/*").scan({ cwd: from, dot: true })) {
      copies.push([path.join(from, rel), path.join(".claude", "skills", skill, rel)]);
    }
  }
  for (const [from, rel] of copies) {
    const to = path.join(dir, rel);
    if (rel === path.join(".claude", "settings.json") && (await exists(to))) {
      await fillSettings(to, await Bun.file(from).json()); // underleaf already wrote its part there
      continue;
    }
    if (await exists(to)) continue;
    // Write by path with the contents in hand: in Bun 1.4.2, writing to a Bun.file() you've
    // probed can produce an empty file.
    await Bun.write(to, await Bun.file(from).arrayBuffer());
  }
  await Bun.write(path.join(dir, ".underleaf", "template"), name + "\n");
  return m.open;
}

/** Add the template's settings to an existing settings file, keeping every value already there. */
async function fillSettings(file: string, template: Record<string, unknown>) {
  const raw = await Bun.file(file).text();
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw);
  } catch {
    return; // not valid JSON: leave it to the user
  }
  const fill = (into: Record<string, unknown>, from: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(from)) {
      const here = into[key];
      if (here === undefined) into[key] = value;
      else if (isObject(here) && isObject(value)) fill(here, value);
    }
  };
  fill(settings, template);
  const next = JSON.stringify(settings, null, 2) + "\n";
  if (next !== raw) await Bun.write(file, next);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Which template a workspace was made from, or null. Workspaces set up before templates existed
 * (the checkout's latex/ got the resume setup automatically) are recognized by their resume skill.
 */
export async function templateOf(dir: string): Promise<string | null> {
  const recorded = (await Bun.file(path.join(dir, ".underleaf", "template")).text().catch(() => "")).trim();
  if (ORDER.includes(recorded)) return recorded;
  if (await exists(path.join(dir, ".claude", "skills", "tailor-resume"))) {
    await Bun.write(path.join(dir, ".underleaf", "template"), "resume\n");
    return "resume";
  }
  return null;
}

/** Write the workspace's .underleaf/instructions.md (shared part + the template's notes) if it changed. */
export async function writeInstructions(dir: string): Promise<string> {
  const name = await templateOf(dir);
  const parts = [await Bun.file(path.join(TEMPLATES, "instructions.md")).text()];
  if (name) {
    const notes = await Bun.file(path.join(TEMPLATES, name, "instructions.md")).text().catch(() => "");
    if (notes.trim()) parts.push(notes);
  }
  const text = parts.map((p) => p.trim()).join("\n\n") + "\n";
  const file = path.join(dir, ".underleaf", "instructions.md");
  if ((await Bun.file(file).text().catch(() => "")) !== text) await Bun.write(file, text);
  return file;
}

/**
 * Whether Claude needs the instructions passed on its command line. Workspaces set up before
 * templates import them from CLAUDE.md; passing them as well would give Claude two copies.
 */
export async function claudeMdImportsInstructions(dir: string): Promise<boolean> {
  const text = await Bun.file(path.join(dir, "CLAUDE.md")).text().catch(() => "");
  return /^@\.underleaf\/instructions\.md\s*$/m.test(text);
}

/** A workspace with no .tex files at all can start from a template. */
export async function isEmptyWorkspace(dir: string): Promise<boolean> {
  for await (const rel of new Bun.Glob("**/*.tex").scan({ cwd: dir })) if (!rel.startsWith(".")) return false;
  return true;
}
