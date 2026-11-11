#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const upstreamRoot = process.env.OAI_UPSTREAM_ROOT || join(root, "..", "open-android-intelligence");
const upstream = join(upstreamRoot, "integrations", "dsh-session-adapter");
const pairs = [
  ["src/index.js", "index.js"], ["src/generation.js", "generation.js"], ["src/diagnostics.js", "diagnostics.js"],
  ["test/adapter.test.js", "adapter.test.js"], ["test/reliability.test.js", "reliability.test.js"],
  ["test/generation.test.js", "generation.test.js"], ["test/host-contract.test.js", "host-contract.test.js"],
  ["test/diagnostics.test.js", "diagnostics.test.js"], ["cordis.patch.yml", "cordis.patch.yml"],
];

// 只归一化已明确的部署入口差异，执行状态、消息及取消实现仍逐字比较。
function normalize(content, entry) {
  if (entry === "index.js") {
    content = content.replace(/^import \* as (fs|os|path) from "node:(fs|os|path)";\n/gm, "");
    const tokenStart = content.indexOf("  let currentToken = token;");
    if (tokenStart >= 0) {
      const validated = content.indexOf("  const validated = Config", tokenStart);
      if (validated < 0) throw new Error("上游Token加载边界已变化，须人工审查");
      content = content.slice(0, tokenStart) + "  const expected = Buffer.from(`Bearer ${token}`);\n" + content.slice(validated);
      const authStart = content.indexOf("      let authenticated = supplied.length");
      const urlStart = content.indexOf("      const url = new URL", authStart);
      if (authStart < 0 || urlStart < 0) throw new Error("上游认证边界已变化，须人工审查");
      content = content.slice(0, authStart)
        + '      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail("AUTHENTICATION_REQUIRED", 401);\n'
        + content.slice(urlStart);
      content = content.replaceAll('createHmac("sha256", currentToken)', 'createHmac("sha256", token)');
    }
    // 独立Bundle允许未配置桥环境时不启动监听，内置安装流程则要求凭据齐备。
    content = content.replace(/  if \(!token\) \{\n    ctx\.logger\?\.(warn|info)\?\.[^\n]+\n    return;\n  \}\n/g, "");
  }
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    .replace(/\.\.\/src\/(index|generation|diagnostics)\.js/g, "./$1.js")
    .replaceAll("name: dsh-android-gateway", "name: oai-dsh-session-adapter")
    .split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
}

let mismatched = false;
for (const [localFile, upstreamFile] of pairs) {
  try {
    const local = normalize(readFileSync(join(root, localFile), "utf8"), upstreamFile);
    const reference = normalize(readFileSync(join(upstream, upstreamFile), "utf8"), upstreamFile);
    if (local !== reference) {
      console.error(`[VERIFY-DRIFT] 不一致：${localFile} ↔ ${upstreamFile}`);
      mismatched = true;
    } else console.log(`[VERIFY-DRIFT] 一致：${localFile}`);
  } catch (error) {
    console.error(`[VERIFY-DRIFT] 核对失败：${localFile}：${error.message}`);
    mismatched = true;
  }
}
if (mismatched) process.exitCode = 1;
else console.log("[VERIFY-DRIFT] 原生会话契约与回归测试保持一致；仅保留已列明的部署入口差异。");
