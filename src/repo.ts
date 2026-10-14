import path from "node:path";

/** The underleaf checkout (templates/, build/, node_modules/ live here). Keep this file at src/'s top level. */
export const REPO = path.resolve(import.meta.dir, "..");
