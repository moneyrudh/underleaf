import { label } from "./core/keys";
import { installHints } from "./ui/hints";
import { initLayout, focusPane } from "./core/layout";
import { initOpening } from "./files/open";
import { initWorkspaces } from "./files/workspaces";
import { initCheatsheet } from "./ui/cheatsheet";
import { commandAvailable, installCommands, runCommand } from "./core/commands";
import { installPopovers } from "./ui/popover";
import { connect } from "./core/connection";
import { STORED, storage } from "./core/util";

/**
 * underleaf's page: file tree | Claude Code | preview. One folder per feature:
 *   core/      state (what's open), connection (websocket), commands (every command and
 *              shortcut), keys, layout (panes, focus, splitters), util
 *   files/     the file tree and opening files (export, quick-open, mentions)
 *   preview/   the PDF / image / source viewer
 *   history/   the version bar and History panel, viewing and restoring versions
 *   compare/   comparing versions or files: the view, the diff, pixel measuring
 *   claude/    the Claude Code terminal
 *   ui/        reusable pieces: palette, dropdown menu, key hints, cheat sheet
 * Types and messages shared with the server live in ../shared/.
 */

initLayout();
initOpening();
initWorkspaces();
initCheatsheet();
installCommands();
installPopovers({ run: runCommand, available: commandAvailable });
for (const kbd of document.querySelectorAll<HTMLElement>("kbd[data-key]")) kbd.textContent = label(kbd.dataset.key!);
installHints();
connect();
focusPane(storage(STORED.claudePane) !== "0" ? "claude" : "tree");
