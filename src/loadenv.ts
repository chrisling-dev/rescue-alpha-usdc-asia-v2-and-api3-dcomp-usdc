// Minimal, dependency-free .env loader. Imported FIRST (before ./config.js) so
// values are in process.env before config reads them. Cross-platform, CRLF-safe,
// and strips a UTF-8 BOM (Windows Notepad adds one, which would corrupt the
// first key). Real environment variables always win over the file.
//
// It is intentionally noisy at startup so "it isn't loading" is debuggable
// remotely: it prints the working dir, every path it checked, and the NAMES of
// the keys it loaded (never the values — your private key is not logged).
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // .../src
const projectRoot = resolve(here, ".."); // package root

// Candidate locations, in order. ENV_FILE override wins.
const candidates = [
  process.env.ENV_FILE,
  resolve(process.cwd(), ".env"),
  join(projectRoot, ".env"),
].filter(Boolean) as string[];

console.log(`[env] cwd: ${process.cwd()}`);

let usedPath: string | undefined;
for (const p of candidates) {
  if (existsSync(p)) {
    usedPath = p;
    break;
  }
  console.log(`[env] not found: ${p}`);
}

if (!usedPath) {
  // Common Windows trap: Notepad saves ".env" as ".env.txt".
  for (const p of candidates) {
    if (existsSync(p + ".txt")) {
      console.log(
        `[env] FOUND ${p}.txt — rename it to ".env" (remove the .txt). ` +
          `Windows hides the extension; enable "File name extensions" in Explorer.`,
      );
    }
  }
  console.log("[env] no .env loaded — using shell env / defaults.");
} else {
  let text = readFileSync(usedPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
      names.push(key);
    }
  }
  console.log(`[env] loaded ${usedPath}`);
  console.log(`[env] keys set: ${names.join(", ") || "(none)"}`);
  console.log(
    `[env] EXECUTE=${process.env.EXECUTE ?? "(unset)"}  ` +
      `PRIVATE_KEY=${process.env.PRIVATE_KEY ? "set ✓" : "MISSING ✗"}`,
  );
}
