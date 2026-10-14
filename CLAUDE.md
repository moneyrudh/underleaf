# underleaf

Local, Overleaf-style LaTeX workspace in the browser: file tree | embedded Claude Code terminal | live PDF preview. A bun server watches `latex/`, recompiles on save, and pushes results over WebSockets. The repo is about the **tool**; direction is toward an AI resume-tailoring agent built on it.

## Commands

- `bun dev [latex-dir] [--resumes dir] [--port N] [--no-open]` — the app (defaults `latex/`, `resumes/`, port 4747)
- `bun run dev:ui` — same, with Bun dev mode (HMR, browser errors echoed to terminal) for working on `public/`. The UI is bundled at server start otherwise, so restart after frontend edits.
- `bun run pdf <file.tex> [out.pdf]` — one-shot export
- `bun run doctor` — check bun / TeX engines / latexmk, print install hints
- `bun run typecheck` — must pass before committing (`bunx --bun tsc`; TS 7 doesn't run on the system Node)
- `bun run smoke` — end-to-end check in headless Chrome (`--keep` leaves the scratch folder). Scratch workspace + seeded history in a temp dir, its own `UNDERLEAF_HOME`, and a stand-in `claude` via `UNDERLEAF_CLAUDE_BIN`, so it never touches your files, history or Claude account. Run it before and after anything structural; add a check when you add a feature.

## Layout

- `src/build/compile.ts` — engine detection (`% !TEX program`, fontspec → xelatex, else pdflatex), latexmk if installed else engine ×≤3 passes, log → diagnostics (unwrapped via `max_print_line` env).
- `src/workspace/files.ts` — tree scan (skips dotfiles/symlinks; `doc` = .tex with `\documentclass`), `resolveTreePath` (realpath containment check), `keepWatching` (recursive fs.watch + 1s inode health check that recreates deleted/replaced roots).
- `public/claude/terminal.ts` maps keys xterm.js doesn't translate (Shift+Enter → `\n`, ⌘⌫ → Ctrl+U, ⌥⌫ → ESC DEL, ⌘/⌥ arrows → readline moves) via `attachCustomKeyEventHandler`.
- `src/claude/session.ts` — starts with `--continue` (falls back to a fresh session if that exits non-zero within 5s), waits for the pane's first resize before spawning, and warns in the pane when `~/.claude.json` isn't readable (root-owned from `sudo claude` → onboarding every launch). One shared `claude` PTY via `Bun.spawn({ terminal })`, 512KB scrollback replayed on reconnect, Enter restarts after exit. Runs the user's **unmodified** `claude` with their own login (per Anthropic's terms; the Agent SDK would require API keys for a distributed app).
- **Layout.** `shared/` holds what both sides use: `types.ts` (FileNode, Snapshot, Diagnostic, ClaudeStart…) and `protocol.ts` (the `API` and `SOCKETS` paths, the `url()` builder, every websocket message, every request/response body). Never hard-code an `/api/…` path or redefine a message shape on one side; change `protocol.ts` and let the typecheck find both ends. Server responses use `satisfies <Type>` so they're checked against it.
- `src/server.ts` and `src/cli.ts` are entry points; `src/repo.ts` is `REPO` (keep it at `src/` top level, it's computed from its own location). Folders: `server/` (`config` args/folders, `routes` HTTP + WS, `clients` tabs + the shared `ClaudeSession` + hook token, `watch` fs changes → rescan/rebuild/edit snapshot, `trees` scanned trees, doc list, workspace brief), `build/` (`compile`, `builds` per-doc queue, last good PDF, `isStale`, export), `history/` (`store` = HistoryStore, `snapshots` triggers, Claude turn state, old-version builds), `workspace/` (`files` scan/kinds/watch, `seed` templates + Claude hooks), `claude/` (`session`, `brief`).
- `src/server/routes.ts` — binds 127.0.0.1; `trusted()` checks Host + Origin on all APIs and WS upgrades. Sidebar paths are `latex/…` / `resumes/…`. Routes: `/api/pdf?doc=`, `/api/file?path=` (sandbox CSP), `POST /api/export` (→ `resumes/` mirroring source path), WS `/ws` (tree + compile events) and `/claude` (PTY).
- `public/core/keys.ts` — keymap: capture-phase window listener so app chords beat xterm. Layers: `global` (mod+p, mod+shift+p, mod+s — fire even in Claude), `leader` (Ctrl+Space then a key), `pane` (vim keys, only when tree/preview focused and not typing; supports sequences like "g g"). Never bind plain Esc or ctrl-letter chords globally — Claude Code needs them.
- `public/ui/hints.ts` — every control with a shortcut shows it: `data-key` on a text button adds a `kbd.k` chip; `data-tip` gives a styled tooltip (with the key) instead, used for icon buttons. Don't use `title` for these. `LEADER` in `data-key` resolves to the platform leader.
- `public/ui/menu.ts` — anchored dropdown with filter + keyboard (used by the compare pickers); never use native `<select>`.
- `public/ui/palette.ts` — fuzzy picker shared by quick-open and the command palette (best-alignment subsequence scoring).
- `public/app.ts` is startup only; one folder per feature. `core/`: `state` (open file, last PDF, roots, recent; toolbar refs), `connection` (WS + message handling), `commands` (**the one registry**: every command with title, keys, scope; keymaps, palette and cheat sheet are generated from it, so add shortcuts there and nowhere else), `keys`, `layout` (panes, focus/`data-focused`, zoom, splitters, the terminal), `util` (`$`, `storage` + **`STORED`, the list of every localStorage key**, toast). `files/`: `tree` (cursor ≠ opened file; changed-file flash), `open` (open/reopen, tree sync, export, mention, quick-open). `preview/preview` (pdf.js v6: `getDocument({url})`, `render({canvas, viewport})`, destroy via loading task; off-screen render then swap). `history/`: `panel` (version bar + History panel), `versions` (view/restore). `compare/`: `compare` (flows), `view` (DiffView), `diffcore`, `ink`. `claude/terminal` (xterm.js + fit addon). `ui/`: `palette`, `menu`, `hints`, `cheatsheet`. Modules import each other in cycles; only touch other modules' exports inside functions, never at module top level. Element ids looked up with `$("…")` must exist in `index.html` (`bun run smoke` checks).
- `build/`, `latex/`, `resumes/` are git-ignored. `examples/` holds committed demo docs. `templates/` is committed and copied into the workspace when missing (`seedWorkspace`: `resume.tex` when `latex/` has no .tex). Anything the in-app agent may personalize (its CLAUDE.md, memory, skills) must ship from `templates/` this way, never be tracked inside `latex/`.

## Version history

- Compare: `public/compare/diffcore.ts` is DOM-free (pdf.js text runs → words with PDF-unit boxes, joining runs split at kerns and dehyphenating line ends; `diffWords` via jsdiff `diffArrays`; `diffSource` = line diff + word marks + folding). `public/compare/view.ts` (`DiffView`) renders both PDFs in one scroller (two grid columns, so they scroll together), plus the source view. Highlight positions come from the rendered pixels (`PageInk`, `public/compare/ink.ts`): pdf.js only gives a run's total width and justified text stretches spaces, so the k widest blank columns in a run are its k spaces and each word is trimmed to its ink; pages with changes are re-rendered off-screen at ≥3 px/pt when the display is 1x. No server changes: sides load from `/api/pdf`, `/api/file`, `/api/history/pdf`, `/api/history/file`. While comparing, `versions.viewing` = the "before" side (so the strip and `,`/`.` move it) and the banner is hidden by `.viewer-col.comparing`.
- `src/history/store.ts`: `HistoryStore` = plain git with `--git-dir=~/.underleaf/history/<id>.git --work-tree=latex/` (`UNDERLEAF_HOME` overrides the root). Workspace id lives in `latex/.underleaf/id` so history survives moving the folder. Snapshot kind/author live in commit trailers (`Underleaf-Kind`, `Underleaf-Path`); authors are `You`/`Claude`/`underleaf`. All git ops are serialized (index.lock). `log()` = `--follow -M` for the file plus exports grepped by exact `Underleaf-Path`, ordered by `rev-list` rank (git times are 1s resolution).
- Triggers (`src/history/snapshots.ts`): edit debounce `EDIT_IDLE_MS` (skipped while a Claude turn is active), Claude `Stop` hook, export (empty commit). Restore snapshots the current state first.
- Claude hooks: `ensureClaudeHooks` merges two `http` hooks (UserPromptSubmit → `?event=prompt`, Stop → `?event=stop`) into `latex/.claude/settings.json` on every start (URL can't interpolate env, so the port is written in). Auth = per-run `UNDERLEAF_HOOK_TOKEN` header passed via `allowedEnvVars`; respond 204 with an empty body (UserPromptSubmit output would be added to Claude's context).
- Past versions compile into `build/<ws>/.history/<commit>/` from `git archive | tar`; `/api/history/pdf` caches per (commit, doc).

## Rules

- **Never commit anything from `latex/` or `resumes/`.** The remote (`github.com/moneyrudh/underleaf`) is public and the author's resumes live there locally.
- File names are untrusted in the UI: `textContent`, never `innerHTML`.
- No Overleaf or Claude Code branding in the product name/logo; plain-text "runs Claude Code" is fine.

## The in-app agent (`templates/workspace/` → `latex/`)

- `seedWorkspace` copies `templates/workspace/**` into the workspace on every start: `.underleaf/*` is underleaf-owned and refreshed when it differs; everything else (CLAUDE.md, memory/, .claude/skills, .claude/settings.json) is copied only if missing. Templates are public: never put real personal data in them.
- `src/claude/brief.ts` writes `latex/.underleaf/workspace.md` (docs, compile status, pages, errors, overfull lines, open file, exports), debounced after rescans and builds. The agent's CLAUDE.md imports it; instructions tell Claude to re-read it after saving.
- Server builds every document once at startup, then on change rebuilds open docs + any document that itself changed, so the snapshot covers files nobody has open. Hidden paths (`.underleaf/`, `.claude/`) are ignored by the watcher.
- The workspace settings disable Claude Code auto memory: `latex/` is inside this repo, and auto memory is keyed per git repo, so it would otherwise be shared with dev sessions here.
- The agent also reads this file (parent directory). Its instructions treat it as background only; keep anything the agent needs in `templates/workspace/`, since binary users won't have this repo.

## Roadmap

1. ~~Hide agent files in the tree ("Show agent memory")~~
2. ~~Version history (snapshots, timeline strip, History panel, restore)~~
3. ~~Diff view ("what the reader sees" + source)~~
4. **PDF → source**: compile with SyncTeX; clicking the preview inserts `@file.tex:LINE ` into Claude's prompt.
5. **Source editor**: a source view beside/instead of the PDF (CodeMirror) for manual edits; saving writes the file, which the watcher turns into a normal "You edited" snapshot.
6. **Distribution**: `bun build --compile` binaries (macOS/Windows/Linux), opening in a Chrome/Edge `--app` window. Revisit git (Windows) and hook shells before shipping.

