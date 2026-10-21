import os from "node:os";
import path from "node:path";

/** underleaf's own data (history, the workspace list), never inside a workspace. UNDERLEAF_HOME moves it (tests use this). */
export const HOME = process.env.UNDERLEAF_HOME ?? path.join(os.homedir(), ".underleaf");
