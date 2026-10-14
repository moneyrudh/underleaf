import { label } from "./keys";
import { installHints } from "./hints";
import { initLayout, focusPane } from "./layout";
import { initOpening } from "./open";
import { initCheatsheet } from "./cheatsheet";
import { installCommands } from "./commands";
import { connect } from "./connection";
import { storage } from "./util";

/**
 * underleaf's page: file tree | Claude Code | preview.
 *   state.ts       what's open, shared by everything below
 *   connection.ts  websocket to the server (tree, builds, history)
 *   open.ts        opening files, the preview toolbar, export, quick-open
 *   versions.ts    viewing and restoring earlier versions
 *   compare.ts     comparing versions or files (the view is diff.ts)
 *   layout.ts      panes, focus, zoom, splitters, the Claude terminal
 *   commands.ts    every command and shortcut; cheatsheet.ts renders them
 */

initLayout();
initOpening();
initCheatsheet();
installCommands();
for (const kbd of document.querySelectorAll<HTMLElement>("kbd[data-key]")) kbd.textContent = label(kbd.dataset.key!);
installHints();
connect();
focusPane(storage("claude-pane") !== "0" ? "claude" : "tree");
