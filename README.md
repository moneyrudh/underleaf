# underleaf

A local LaTeX workspace with the Overleaf experience, and with Claude Code built in. You get a file tree on the left, a real Claude Code session in the middle, and a live PDF preview on the right. Ask Claude to edit your `.tex`, and the preview re-renders on every save. Save the PDF when you're happy with it.

Everything runs on your machine. No account, no compile timeouts, and your documents never leave your computer.

## Setup

You need [bun](https://bun.sh) and a TeX distribution. For the Claude pane, you also need [Claude Code](https://claude.com/claude-code), installed and logged in.

```sh
git clone https://github.com/moneyrudh/underleaf.git
cd underleaf
bun install
bun run doctor     # checks your LaTeX install and tells you what's missing
```

If `doctor` can't find LaTeX:

| OS | Install |
|---|---|
| macOS | `brew install --cask basictex` (small) or `brew install --cask mactex-no-gui` (everything), then open a new terminal |
| Debian / Ubuntu | `sudo apt install texlive-latex-extra texlive-fonts-extra latexmk` |
| Fedora | `sudo dnf install texlive-scheme-medium latexmk` |
| Windows | [MiKTeX](https://miktex.org/download) |

`latexmk` is optional. If it's installed, underleaf uses it (better bibliography and rerun handling); otherwise it calls the engine directly.

## Usage

```sh
bun dev                       # opens http://localhost:4747 on the folder you had open last
bun dev ~/Documents/thesis    # opens a specific folder
bun dev examples              # try the bundled example
bun run pdf latex/main.tex    # one-off export from the terminal
```

Options: `bun dev [folder] [--port N] [--no-open]`.

### Workspaces

A workspace is one folder of documents: a thesis, a set of resumes, a paper. Each has its own files, version history, and Claude conversation, so a thesis and a resume never share instructions or memory.

The folder name in the title bar switches between workspaces you've opened, and **Open folder…** opens another one with your system's folder dialog (also in the command palette, along with **Switch workspace…**). Switching swaps the file tree, the history and Claude's folder; Claude picks up that folder's last conversation. underleaf adds two small things to a folder you open: `.underleaf/` (the history id and a status file for Claude) and its hooks in `.claude/settings.json`.

With no folder given, a fresh checkout uses its own `latex/` folder (git-ignored, so personal files never end up in this repo) and gives it the starter resume setup: a `resume.tex` from `templates/resume.tex` plus the agent files below. Folders you open don't get those added.

### Saving PDFs

| Action | What it does |
|---|---|
| **Save PDF** (⌘S) | Saves over the file you last saved this document to. The first time, it asks where (like Save As). |
| **Save As…** (⌘⇧S) | Your system's save dialog. The file you choose becomes what ⌘S saves over. |
| **Save to Downloads** | A plain download, a new file each time. |

Each document remembers its own file. The save dialog needs Chrome or Edge; in other browsers, Save PDF and Save As download instead. Every save leaves a marker in the document's version history ("Saved as draft-3.pdf"), so you can always get back the exact version you sent. Saving waits for a good build: while the document is building, or if its latest build failed, the PDF on screen is older than your source, so Save says why instead of saving.

### The file tree

Click a folder to expand it, and click a file to open it:

| File | What happens |
|---|---|
| `.tex` with `\documentclass` | Compiles and previews live, with errors in **Logs**, page count, and **Save PDF** |
| `.tex` without it (`\input` fragments) | Shown as source. Saving it still rebuilds whichever document you have open. |
| `.pdf` | Rendered |
| images | Shown as-is |
| `.bib`, `.cls`, `.sty`, `.md`, `.txt`… | Shown as text |
| anything else | Listed, with a download button |

Hidden files (dotfiles) and symlinks are left out of the tree.

### The Claude pane

It runs your own installed `claude` with your own login, in a real terminal (xterm.js on top of a PTY), so you get the full Claude Code UI: permission prompts, slash commands, and everything else. The session lives in the server process, so reloading the page reconnects you to the same session. When underleaf starts, Claude picks up your most recent conversation in `latex/` (`claude --continue`). The command palette has **new conversation** and **resume a previous conversation…** (Claude's own session picker). If Claude exits, press Enter to pick up where you left off. Toggle the pane with **Claude** in the top bar.

#### The resume agent

On startup, underleaf sets up `latex/` as a workspace for a resume-focused agent:

| Path | Owner | Purpose |
|---|---|---|
| `CLAUDE.md` | you | Imports the files below. Add your own standing instructions here. |
| `.underleaf/instructions.md` | underleaf | The agent's role and ground rules (never invent facts, one page, tailored versions in their own folder…). Refreshed on update. |
| `.underleaf/workspace.md` | underleaf | Live snapshot: every document's compile status, page count, errors, and what's open. Claude re-reads it after edits. |
| `memory/profile.md`, `memory/experience.yaml`, `memory/applications.md` | Claude & you | Long-term memory: who you are, a structured bank of every role and bullet, and a log of tailored applications. |
| `.claude/skills/` | Claude & you | `tailor-resume`, `fit-one-page`, `update-memory`. Claude uses them automatically, or you can type `/tailor-resume`. |
| `.claude/settings.json` | you | Accepts file edits without prompting, and turns off Claude Code's built-in auto memory so `memory/` is the single source. |

Files marked "you" or "Claude & you" are copied in only when missing, so your changes are never overwritten. Everything lives in the git-ignored `latex/`, so it stays private. For history, run `git init` inside `latex/`.

On first use, ask Claude to build your experience bank from your existing resumes.

`CLAUDE.md` and `memory/` are hidden from the file tree by default. Run **Show agent memory** from the command palette (⌘⇧P) to see or edit what Claude remembers.

### Version history

underleaf snapshots `latex/` automatically, so you can look back at any earlier version of a file and restore it:

| When | Snapshot label |
|---|---|
| You pause editing for ~10 seconds | "You edited main.tex" |
| Claude finishes a turn that changed files | "Claude: *your prompt*" |
| You save a PDF | "Saved as draft-3.pdf" or "Downloaded main.pdf" (so every PDF you sent maps to its exact source) |

The **version bar** above the preview is a timeline of the open file: oldest on the left, **Now** on the right. Hover a dot for its label, click it to open that version, or step through with `,` (older) and `.` (newer). Press `V` to hide or show the bar. For the full list with labels, open **History** in the preview toolbar (or press `H`). Click a snapshot to preview that version (documents are compiled as they were). **Restore this version** puts it back, and the version it replaces is saved first, so a restore can be undone too. History follows renames.

### Comparing versions

Press `C` in the preview to see what changed since the previous version of the open file. You can also click **Compare** on any row in History, or **Compare with current** in the banner of an earlier version. To compare two files, such as two tailored resumes, run **Compare with another file…** from the command palette.

- **Reader** (the default) shows what a reader sees: both PDFs side by side. Removed words are red on the left, added words are green on the right, and a thin marker shows where text was cut or inserted. Changes are word by word on the compiled text, so moving a line break or reflowing a paragraph doesn't show up as an edit.
- **Source** (`S`) shows the LaTeX itself as a line diff with the changed words highlighted. Unchanged stretches are folded; click one to expand it. Files that don't compile to a PDF (Markdown, BibTeX, `\input` fragments) always use this view.

Pick either side from the two menus. While comparing, the version bar and `,`/`.` move the "before" side. `]c`/`[c` jump between changes, and `Esc` (or **Done**) goes back. If the current version is one side, the comparison updates live as you or Claude edit.

History is stored in `~/.underleaf/history/`, not in your folder (set `UNDERLEAF_HOME` to move it). It needs `git` installed; without it, everything else still works. To label Claude's turns, underleaf adds two hooks to `latex/.claude/settings.json` (anything else in that file is left as is).

### Keyboard

Press `?` (or the **?** button) for the full list. The essentials:

| Key | Action |
|---|---|
| `⌘P` / `Ctrl+P` | Go to file (fuzzy search) |
| `⌘⇧P` / `Ctrl+Shift+P` | Command palette |
| `⌘S` / `Ctrl+S` | Save PDF (`⌘⇧S`: Save As…) |
| `Ctrl+Space` then `h` / `l` / `1` `2` `3` | Move between panes (files, Claude, preview) |
| `Ctrl+Space` then `z` | Zoom the focused pane |

The `‹` in the Files header collapses the file tree to a slim rail; `›` brings it back.

Vim-style keys work when the file tree or preview has focus:
- **Tree:** `j`/`k`, `h`/`l`, `gg`/`G`, Enter, `a` to mention the file in Claude, `y` to copy its path.
- **Preview:** `j`/`k`, `d`/`u`, `gg`/`G`, `+`/`-`/`=` to zoom, `]e`/`[e` to step through errors, `L` for logs, `H` for history, `,`/`.` for older/newer versions, `V` for the version bar, `C` to compare with the previous version (`]c`/`[c` next/previous change, `S` reader ↔ source, `Esc` to close).

While Claude has focus, every other key goes to Claude, including Esc to interrupt it. Shift+Enter inserts a newline, and the macOS editing keys work like they do in Terminal or iTerm2: ⌘⌫ deletes the line, ⌥⌫ deletes a word, ⌘←/→ jumps to the line start or end, ⌥←/→ moves by word.

On macOS, `Ctrl+Space` switches input sources if you have more than one keyboard language enabled. In that case, change or disable that shortcut in System Settings → Keyboard → Keyboard Shortcuts → Input Sources.

### Security

The server only listens on `127.0.0.1`, and it rejects requests from other origins and hosts. That matters because it can drive a coding agent.

## How it works

The server (`src/`) watches the open workspace, compiles through `src/build/compile.ts` into `build/`, runs Claude Code through `src/claude/session.ts`, and talks to the browser over WebSockets; `src/server.ts` lists the pieces. `bun run smoke` runs an end-to-end check in headless Chrome. The UI in `public/` renders PDFs with [pdf.js](https://mozilla.github.io/pdf.js/) and the terminal with [xterm.js](https://xtermjs.org/).

---

Inspired by [Overleaf](https://www.overleaf.com). Not affiliated with Overleaf or Anthropic.
