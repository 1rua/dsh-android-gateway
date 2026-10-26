#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const upstreamRoot = process.env.OAI_UPSTREAM_ROOT || join(root, "..", "open-android-intelligence");
const upstreamAdapterDir = join(upstreamRoot, "integrations", "dsh-session-adapter");

const filesToVerify = [
  { local: "src/index.js", upstream: "index.js" },
  { local: "test/adapter.test.js", upstream: "adapter.test.js" },
  { local: "cordis.patch.yml", upstream: "cordis.patch.yml" },
];

// Normalize relative import differences and bundle package name differences
const normalize = (content) => content
  .replace(/\.\.\/src\/index\.js/g, "./index.js")
  .replace(/name: dsh-android-gateway/g, "name: oai-dsh-session-adapter")
  .replace(/  if \(!token\) \{\n    ctx\.logger\?\.(warn|info)\?\.[^\n]+\n    return;\n  \}\n/g, "");

let hasMismatch = false;

for (const { local, upstream } of filesToVerify) {
  const localPath = join(root, local);
  const upstreamPath = join(upstreamAdapterDir, upstream);
  try {
    const localContent = normalize(readFileSync(localPath, "utf8"));
    const upstreamContent = normalize(readFileSync(upstreamPath, "utf8"));
    if (localContent !== upstreamContent) {
      console.error(`[VERIFY-DRIFT] MISMATCH detected between ${local} and upstream ${upstream}!`);
      hasMismatch = true;
    } else {
      console.log(`[VERIFY-DRIFT] OK: ${local} matches upstream ${upstream}`);
    }
  } catch (err) {
    console.error(`[VERIFY-DRIFT] Error reading files: ${err.message}`);
    hasMismatch = true;
  }
}

if (hasMismatch) {
  process.exit(1);
} else {
  console.log("[VERIFY-DRIFT] All upstream reference files verified successfully without drift.");
}
