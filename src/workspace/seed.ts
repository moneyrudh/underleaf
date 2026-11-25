import path from "node:path";
import { mkdir } from "node:fs/promises";
import { API } from "../../shared/protocol";
import { BLOCK_WRITES_OUTSIDE, GUARDRAILS, type Guardrails } from "./guardrails";

/**
 * Install the agent setup from templates/ into the workspace.
 * - `.underleaf/` is owned by underleaf: refreshed whenever the template changes.
 * - Everything else (CLAUDE.md, memory, skills, settings) is copied only if missing,
 *   because the user and Claude personalize those files.
 * - An empty workspace also gets a starter resume.tex.
 */
export async function seedWorkspace(latexDir: string, templatesDir: string) {
  await mkdir(latexDir, { recursive: true });
  const source = path.join(templatesDir, "workspace");
  for await (const rel of new Bun.Glob("**/*").scan({ cwd: source, dot: true })) {
    const template = await Bun.file(path.join(source, rel)).text();
    const dest = path.join(latexDir, rel);
    // Read via a fresh handle: in Bun 1.4.2, writing to a Bun.file() you've called
    // .exists() on produces an empty file, so always write by path with explicit contents.
    const current = await Bun.file(dest).text().catch(() => null);
    if (rel === ".underleaf/id") continue; // each workspace's own; never copied from a template
    const managed = rel.startsWith(".underleaf/");
    // An empty file counts as missing: it was never personalized (and repairs bad copies).
    if (managed ? current === template : current !== null && current.length > 0) continue;
    await Bun.write(dest, template);
    console.log(`${managed ? "updated" : "added"}   ${rel}`);
  }

  for await (const _ of new Bun.Glob("**/*.tex").scan({ cwd: latexDir })) return;
  await Bun.write(path.join(latexDir, "resume.tex"), Bun.file(path.join(templatesDir, "resume.tex")));
  console.log(`added   resume.tex (starter template)`);
}

type Settings = {
  hooks?: Record<string, { hooks: { url?: string; command?: string }[] }[]>;
  permissions?: { deny?: string[]; ask?: string[]; [key: string]: unknown };
  [key: string]: unknown;
};

/**
 * underleaf's part of the workspace's .claude/settings.json, merged in on every start without
 * touching anything else in it:
 * - Permission rules that keep Claude to the workspace (guardrails.ts). The rules underleaf wrote
 *   last time are recorded in .underleaf/managed-settings.json, so a rule dropped from a later
 *   version is removed too, and a rule the user wrote themselves is never touched.
 * - With `hookBase`: hooks that tell underleaf when a Claude turn starts (the prompt becomes the
 *   snapshot label) and ends (take the snapshot). HTTP hooks can't interpolate env vars into the URL,
 *   so the current port is written in on every start; the per-run token travels in a header and only
 *   exists in the environment underleaf gives Claude.
 */
export async function ensureClaudeSettings(dir: string, hookBase: string | null) {
  const file = path.join(dir, ".claude", "settings.json");
  const raw = await Bun.file(file).text().catch(() => "{}");
  let settings: Settings;
  try {
    settings = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    console.warn(`${file} isn't valid JSON; leaving it alone (Claude Code won't load it either: no guardrails, no turn labels)`);
    return;
  }

  // Permissions: replace what underleaf added last time with the current rules.
  const record = path.join(dir, ".underleaf", "managed-settings.json");
  const previous = ((await Bun.file(record).json().catch(() => null)) ?? { deny: [], ask: [] }) as Guardrails;
  const permissions = (settings.permissions ??= {});
  for (const kind of ["deny", "ask"] as const) {
    const mine = new Set([...previous[kind], ...GUARDRAILS[kind]]);
    permissions[kind] = [...(permissions[kind] ?? []).filter((r) => !mine.has(r)), ...GUARDRAILS[kind]];
  }
  permissions[BLOCK_WRITES_OUTSIDE] = true;

  if (hookBase) {
    const hooks = (settings.hooks ??= {});
    const ours = (event: string) => ({
      type: "http",
      url: `${hookBase}${API.claudeHook}?event=${event}`,
      timeout: 5,
      headers: { "X-Underleaf-Token": "$UNDERLEAF_HOOK_TOKEN" },
      allowedEnvVars: ["UNDERLEAF_HOOK_TOKEN"],
    });
    for (const [event, name] of [["UserPromptSubmit", "prompt"], ["Stop", "stop"]] as const) {
      // Drop any earlier underleaf entry (e.g. a different port), keep everything else.
      const groups = (hooks[event] ?? [])
        .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !h.url?.includes(API.claudeHook)) }))
        .filter((g) => g.hooks.length > 0);
      groups.push({ hooks: [ours(name)] });
      hooks[event] = groups;
    }
  }

  const next = JSON.stringify(settings, null, 2) + "\n";
  if (next !== raw) await Bun.write(file, next);
  const recorded = JSON.stringify(GUARDRAILS, null, 2) + "\n";
  if ((await Bun.file(record).text().catch(() => "")) !== recorded) await Bun.write(record, recorded);
}
