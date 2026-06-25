// Minimal, dependency-free .env loader. Imported FIRST (before ./config.js) so
// the values are in process.env before config reads them. Cross-platform and
// CRLF-safe (Windows). Real environment variables always win over the file.
import { readFileSync, existsSync } from "node:fs";

const path = process.env.ENV_FILE ?? ".env";

if (existsSync(path)) {
  let loaded = 0;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip optional surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
      loaded++;
    }
  }
  console.log(`[env] loaded ${loaded} var(s) from ${path}`);
} else {
  console.log(`[env] no ${path} found (using shell env / defaults)`);
}
