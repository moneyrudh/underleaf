/**
 * What Claude may not do in a workspace, written into its .claude/settings.json as permission rules.
 * The instructions (.underleaf/instructions.md) tell Claude to stay on task; these rules hold even
 * when something it reads (a pasted job description, a downloaded paper) tells it otherwise.
 *
 * Deny rules in project settings win over allow rules anywhere (user, local, command line) and apply
 * in every permission mode, so a user can't loosen them from inside the workspace either.
 *
 * Rules are relative to the workspace (`/x` = <workspace>/x in project settings). Bash rules match the
 * command text Claude writes, so they stop the usual form (`rm -rf x`) but not every disguise
 * (`/bin/rm`, `sh -c '…'`): a guard against mistakes and casual misuse, not a sandbox.
 */

export type Guardrails = { deny: string[]; ask: string[] };

export const GUARDRAILS: Guardrails = {
  deny: [
    // No web access: fetched pages are the easiest way to slip instructions in, or data out.
    "WebFetch",
    "Bash(curl *)",
    "Bash(wget *)",
    // No deleting. Restoring from history is one click; a deleted file Claude was wrong about isn't.
    "Bash(rm *)",
    "Bash(rmdir *)",
    "Bash(unlink *)",
    "Bash(git clean *)",
    // underleaf's own files, and the settings that hold these rules.
    "Edit(/.underleaf/**)",
    "Edit(/.claude/settings.json)",
    "Edit(/.claude/settings.local.json)",
  ],
  ask: [
    // Claude's own instructions and skills: allowed, but always with the user's yes.
    "Edit(/CLAUDE.md)",
    "Edit(/.claude/**)",
  ],
};

/** File tools (Edit, Write) refuse paths outside the workspace, in every permission mode. */
export const BLOCK_WRITES_OUTSIDE = "blockWritesOutsideWorkingDirectories";
