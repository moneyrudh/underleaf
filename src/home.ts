import os from "node:os";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";

/**
 * underleaf's own folder, where the app keeps everything it manages: your projects, their version
 * history, the build cache and the list of recent projects. It's the operating system's place for an
 * app's data, out of sight in Finder (Show files in Finder opens a project there for anyone curious):
 *   macOS    ~/Library/Application Support/underleaf
 *   Windows  %APPDATA%\underleaf
 *   Linux    $XDG_DATA_HOME/underleaf, else ~/.local/share/underleaf
 * UNDERLEAF_HOME moves it (the smoke test uses this to never touch your data).
 */
function appData(): string {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "underleaf");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "underleaf");
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "underleaf");
}

/**
 * `p` with symlinks resolved, as far as it exists (/var → /private/var on macOS), so it compares equal to
 * folder paths that were resolved with realpath. The part that doesn't exist yet is kept as written.
 */
function real(p: string): string {
  let existing = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(realpathSync(existing), ...rest);
}

export const HOME = real(process.env.UNDERLEAF_HOME ?? appData());
export const PROJECTS = path.join(HOME, "projects");
export const BUILD = path.join(HOME, "build");
