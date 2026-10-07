# underleaf

Local, Overleaf-style LaTeX workspace in the browser: file tree | embedded Claude Code terminal | live PDF preview. A bun server watches `latex/`, recompiles on save, and pushes results over WebSockets. The repo is about the **tool**; direction is toward an AI resume-tailoring agent built on it.

## Commands

- `bun dev [latex-dir] [--resumes dir] [--port N] [--no-open]` — the app (defaults `latex/`, `resumes/`, port 4747)
- `bun run dev:ui` — same, with Bun dev mode (HMR, browser errors echoed to terminal) for working on `public/`. The UI is bundled at server start otherwise, so restart after frontend edits.
- `bun run pdf <file.tex> [out.pdf]` — one-shot export
- `bun run doctor` — check bun / TeX engines / latexmk, print install hints
- `bun run typecheck` — must pass before committing (`bunx --bun tsc`; TS 7 doesn't run on the system Node)

## Layout

- `src/compile.ts` — engine detection (`% !TEX program`, fontspec → xelatex, else pdflatex), latexmk if installed else engine ×≤3 passes, log → diagnostics (unwrapped via `max_print_line` env).
- `src/workspace.ts` — tree scan (skips dotfiles/symlinks; `doc` = .tex with `\documentclass`), `resolveTreePath` (realpath containment check), `keepWatching` (recursive fs.watch + 1s inode health check that recreates deleted/replaced roots).
- `src/claude.ts` — one shared `claude` PTY via `Bun.spawn({ terminal })`, 512KB scrollback replayed on reconnect, Enter restarts after exit. Runs the user's **unmodified** `claude` with their own login (per Anthropic's terms; the Agent SDK would require API keys for a distributed app).
- `src/server.ts` — binds 127.0.0.1; `trusted()` checks Host + Origin on all APIs and WS upgrades. Sidebar paths are `latex/…` / `resumes/…`. Routes: `/api/pdf?doc=`, `/api/file?path=` (sandbox CSP), `POST /api/export` (→ `resumes/` mirroring source path), WS `/ws` (tree + compile events) and `/claude` (PTY).
- `public/` — `app.ts` (state, selection, layout/splitters), `tree.ts`, `preview.ts` (pdf.js v6: `getDocument({url})`, `render({canvas, viewport})`, destroy via loading task; off-screen render then swap), `terminal.ts` (xterm.js + fit addon).
- `build/`, `latex/`, `resumes/` are git-ignored. `examples/` holds committed demo docs.

## Rules

- **Never commit anything from `latex/` or `resumes/`.** The remote (`github.com/moneyrudh/underleaf`) is public and the author's resumes live there locally.
- File names are untrusted in the UI: `textContent`, never `innerHTML`.
- No Overleaf or Claude Code branding in the product name/logo; plain-text "runs Claude Code" is fine.
