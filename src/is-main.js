import { fileURLToPath } from "url";
import { resolve } from "path";

/** True when this module was started with `node path/to/this-file.js`, not when imported. */
export function isMain(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(fileURLToPath(importMetaUrl)) === resolve(entry);
}
