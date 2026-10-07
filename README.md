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
bun dev                       # opens http://localhost:4747
bun dev examples              # try the bundled example
bun run pdf latex/main.tex    # one-off export from the terminal
```

Options: `bun dev [latex-dir] [--resumes dir] [--port N] [--no-open]`.

### Folders

| Folder | What it's for |
|---|---|
| `latex/` | Your sources. Everything in here shows up in the file tree, and Claude works here. |
| `resumes/` | Exported PDFs. **Save PDF** writes here, mirroring the source path (`latex/acme/main.tex` → `resumes/acme/main.pdf`). |

Both are git-ignored, so personal files never end up in this repo. You can make either one its own git repo if you want history. If you delete or rename either folder while the app is running, underleaf recreates it empty and keeps going.

### The file tree

Click a folder to expand it, and click a file to open it:

| File | What happens |
|---|---|
| `.tex` with `\documentclass` | Compiles and previews live, with errors in **Logs**, page count, and **Save PDF** |
| `.tex` without it (`\input` fragments) | Shown as source. Saving it still rebuilds whichever document you have open. |
| `.pdf` | Rendered (handy for checking what's in `resumes/`) |
| images | Shown as-is |
| `.bib`, `.cls`, `.sty`, `.md`, `.txt`… | Shown as text |
| anything else | Listed, with a download button |

Hidden files (dotfiles) and symlinks are left out of the tree.

### The Claude pane

It runs your own installed `claude` with your own login, in a real terminal (xterm.js on top of a PTY), so you get the full Claude Code UI: permission prompts, slash commands, and everything else. The session lives in the server process, so reloading the page reconnects you to the same session. If Claude exits, press Enter to start a new one. Toggle the pane with **Claude** in the top bar.

### Security

The server only listens on `127.0.0.1`, and it rejects requests from other origins and hosts. That matters because it can drive a coding agent.

## How it works

`src/server.ts` watches `latex/` and `resumes/` (`src/workspace.ts`), compiles through `src/compile.ts` into `build/`, runs Claude Code through `src/claude.ts`, and talks to the browser over WebSockets. The UI in `public/` renders PDFs with [pdf.js](https://mozilla.github.io/pdf.js/) and the terminal with [xterm.js](https://xtermjs.org/).

---

Inspired by [Overleaf](https://www.overleaf.com). Not affiliated with Overleaf or Anthropic.
