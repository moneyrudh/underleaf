# underleaf

A local LaTeX workspace with the Overleaf experience, and with Claude Code built in. You get a file tree on the left, a real Claude Code session in the middle, and a live PDF preview on the right. Ask Claude to edit your `.tex`, and the preview re-renders on every save. Save the PDF when you're happy with it.

Everything runs on your machine. No account, no compile timeouts, and your documents never leave your computer.

The app will be available to download cross-platform soon.

## Visual

<img width="1710" height="980" alt="Screenshot 2026-10-23 at 11 01 38 AM" src="https://github.com/user-attachments/assets/7adf8aad-fdfa-4bd7-968e-96402502a53b" />

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
bun run new ~/thesis --template thesis   # start a folder from a template
bun run pdf latex/main.tex    # one-off export from the terminal
```

Options: `bun dev [folder] [--port N] [--no-open]`.

### Workspaces

A workspace is one folder of documents: a thesis, a set of resumes, a paper. Each has its own files, version history, and Claude conversation, so a thesis and a resume never share instructions or memory.

The folder name in the title bar switches between workspaces you've opened, and **Open folder…** opens another one with your system's folder dialog (also in the command palette, along with **Switch workspace…**). Switching swaps the file tree, the history and Claude's folder; Claude picks up that folder's last conversation. underleaf adds two small things to a folder you open: `.underleaf/` (the history id and a status file for Claude) and, in `.claude/settings.json`, its hooks and the permission rules described under [Security](#security).

With no folder given, a fresh checkout uses its own `latex/` folder, which is git-ignored so personal files never end up in this repo.

A folder with no `.tex` files opens on a template picker: **Resume**, **Thesis**, **Article**, or **Blank**. `bun run new <folder> --template <name>` does the same from the terminal. A template only fills an empty folder and never overwrites a file that's already there.

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
| `.tex` with `\documentclass` | Compiles and previews live; its text can be edited on the page, its LaTeX in Source. Errors in **Logs**, page count, and **Save PDF** |
| `.tex` without it (`\input` fragments) | Opens in the editor. Saving it rebuilds whichever document you have open (and its text can be edited on that document's page). |
| `.pdf` | Rendered |
| images | Shown as-is |
| `.bib`, `.cls`, `.sty`, `.md`, `.txt`… | Opens in the editor |
| anything else | Listed, with a download button |

Hidden files (dotfiles) and symlinks are left out of the tree.

### The Claude pane

It runs your own installed `claude` with your own login, in a real terminal (xterm.js on top of a PTY), so you get the full Claude Code UI: permission prompts, slash commands, and everything else. The session lives in the server process, so reloading the page reconnects you to the same session. When underleaf starts, Claude picks up your most recent conversation in the workspace (`claude --continue`). The command palette has **new conversation** and **resume a previous conversation…** (Claude's own session picker). If Claude exits, press Enter to pick up where you left off. Toggle the pane with **Claude** in the top bar.

#### Claude's setup in a workspace

Claude is set up as a writing assistant for the workspace's documents: their text, LaTeX, figures, data, and bibliography. It declines other tasks, and permission rules back that up (see [Security](#security)).

| Path | Owner | Purpose |
|---|---|---|
| `.underleaf/instructions.md` | underleaf | Claude's role and ground rules (never invent facts or citations, don't delete or rename without asking…), plus notes for the workspace's kind of document. Rewritten on every start, so it follows underleaf updates. |
| `.underleaf/workspace.md` | underleaf | Live snapshot: every document's compile status, page count, errors, and what's open. Claude re-reads it after edits. |
| `CLAUDE.md` | you | Your own standing instructions ("British spelling", "the venue's limit is 8 pages"). They take priority over underleaf's. |
| `.claude/skills/` | Claude & you | Workflows from the template. Claude uses them when they fit, or type `/<name>`. |
| `.claude/settings.json` | you | Accepts file edits without prompting. underleaf merges in its hooks and permission rules on every start and leaves the rest alone. |

What each template adds:

| Template | Files | Skills |
|---|---|---|
| **Resume** | `resume.tex`; `memory/` with your profile, an experience bank of every role and bullet, and a log of applications | `tailor-resume`, `fit-one-page`, `update-memory` |
| **Thesis** | `main.tex` with one file per chapter in `chapters/`, `references.bib`, `notes/terminology.md` | `check-citations`, `consistent-terminology` |
| **Article** | `main.tex` with an abstract, `references.bib` | `check-citations` |
| **Blank** | `main.tex` | none |

underleaf hands Claude its instructions when it starts Claude in the folder, so nothing is added to your `CLAUDE.md`. Templates live in `templates/` (one folder each, plus `templates/instructions.md` for the part every workspace gets).

For a resume workspace, ask Claude on first use to build your experience bank from your existing resumes.

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

### Editing

**On the page.** The preview is your compiled PDF, and its text can be edited where it stands. Hover to see what can be changed: a heading, a job title, a date, a whole bullet, a paragraph, each outlined on every line it covers. Click it and it becomes a text box right on the page. Type, then press Enter (or click away; Esc cancels). underleaf writes the change into your LaTeX at exactly the words that printed it, leaving the commands around them alone and escaping characters LaTeX treats specially (`%`, `&`, `$`…); a change that would cut through formatting (say, joining a bold word with the next) is refused rather than written, and the page redraws with the result a moment later. Because the page is TeX's own output, what you edit is exactly what you'll send.

What can be edited on the page is the text your source spells out: paragraphs, headings, list items, the arguments of your own macros (a resume's titles, dates, bullets). Bullets, icons, page numbers, math and text a macro generates aren't, and structure (a new section, a new item) isn't either: that's for Source.

**Source.** The raw LaTeX, in the middle column where Claude is (**Claude | Source**, or press `e`). Other text files (`\input` chapters, `.bib`, notes) open in the editor in the preview.

Both save the same way: edits are saved a moment after you stop typing (`⌘S` in the editor saves at once; elsewhere it saves the PDF), each save rebuilds the document and lands in version history as "You edited". If Claude changes the file you're editing in Source, it takes the new version when you have nothing unsaved; if you do, it asks: **Use the version on disk** or **Keep mine**.

### Keyboard

Press `?` (or the **?** button) for the full list. The essentials:

| Key | Action |
|---|---|
| `⌘P` / `Ctrl+P` | Go to file (fuzzy search) |
| `⌘⇧P` / `Ctrl+Shift+P` | Command palette |
| `⌘S` / `Ctrl+S` | Save PDF (`⌘⇧S`: Save As…); in the editor, save the file |
| `e` | Show the open file's LaTeX (Source) in the middle column, or Claude again |
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

Claude is set up to help with the workspace's documents and to decline other tasks. Because a document can contain instructions too (a pasted job description, a downloaded paper), underleaf also writes permission rules into each workspace's `.claude/settings.json` (`src/workspace/guardrails.ts`):

| Claude can't | Why |
|---|---|
| Fetch web pages, or run `curl` / `wget` | the easiest way to slip instructions in or data out |
| Delete files (`rm`, `rmdir`, `unlink`, `git clean`) | restoring from history is easy; undoing a deletion isn't |
| Write outside the workspace | it's there for this folder only (needs Claude Code 2.1.314 or later) |
| Edit `.underleaf/` or `.claude/settings*.json` | underleaf's own files, and the rules themselves |

Editing `CLAUDE.md` or anything else in `.claude/` (skills) always asks you first. Deny rules in project settings win over allow rules in any other settings file and apply in every permission mode. The shell rules match the command Claude writes, so they stop the usual form (`rm file`) but not every disguise (`/bin/rm`, `sh -c "…"`). They guard against mistakes and casual misuse; for a hard boundary, turn on Claude Code's [sandboxing](https://code.claude.com/docs/en/sandboxing).

## How it works

The server (`src/`) watches the open workspace, compiles through `src/build/compile.ts` into `build/`, runs Claude Code through `src/claude/session.ts`, and talks to the browser over WebSockets; `src/server.ts` lists the pieces. `bun run smoke` runs an end-to-end check in headless Chrome. The UI in `public/` renders PDFs with [pdf.js](https://mozilla.github.io/pdf.js/) and the terminal with [xterm.js](https://xtermjs.org/).

---

Inspired by [Overleaf](https://www.overleaf.com). Not affiliated with Overleaf or Anthropic.
