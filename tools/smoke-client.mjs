#!/usr/bin/env node
/**
 * 起一个「假手机」对真实 DSH 做端到端冒烟：
 * 协商 → 登录 → 建会话 → 订阅 SSE → 发消息 → 看到流式增量与完成 → 读历史。
 *
 * 用法：
 *   node tools/smoke-client.mjs --url http://127.0.0.1:43535 \
 *     --setup "$DSH_HOME/dsh-android-gateway/setup-account.json" \
 *     --prompt "用一句话介绍你自己"
 *
 * 需要先 `npm run build`（脚本复用 lib 中的契约摘要与签名实现）。
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import { CORE_SCHEMA_HASH, canonicalRequestSignatureInput } from "../lib/src/protocol/index.js";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const baseUrl = (arg("url", process.env.DSH_WEB_URL ?? "http://127.0.0.1:43535")).replace(/\/+$/, "");
const setupPath = arg("setup", process.env.DSH_ANDROID_SETUP ?? "");
const prompt = arg("prompt", "请用一句话确认你已经连接到 DeepSeek Harness。");
const timeoutMs = Number(arg("timeout", "180000"));
const MOUNT = "/open-android-intelligence/v2";

if (setupPath.length === 0) {
  console.error("缺少 --setup <setup-account.json>（或 DSH_ANDROID_SETUP 环境变量）");
  process.exit(2);
}
const setup = JSON.parse(readFileSync(setupPath, "utf8"));
const username = arg("username", setup.username);
const password = arg("password", setup.password);

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const devicePublicKey = publicKey.export({ format: "jwk" }).x;
const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

const postJson = async (target, body, extraHeaders = {}) => {
  const response = await fetch(`${baseUrl}${MOUNT}${target}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${target} 返回非 JSON（${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`${target} 失败（${response.status}）：${json?.error?.code ?? text.slice(0, 200)}`);
  }
  return json.data;
};

const session = { accountId: "", deviceId: "", sessionId: "", accessToken: "" };

const signedFetch = async (method, target, body = null) => {
  const bodyText = body === null ? "" : JSON.stringify(body);
  const bodyBytes = Buffer.from(bodyText, "utf8");
  const requestId = `req_${randomBytes(10).toString("hex")}`;
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(16).toString("base64url");
  const canonicalTarget = `${MOUNT}${target}`;
  const preimage = canonicalRequestSignatureInput({
    method,
    target: canonicalTarget,
    accountId: session.accountId,
    deviceId: session.deviceId,
    sessionId: session.sessionId,
    requestId,
    timestamp,
    nonce,
    body: bodyBytes,
  });
  const signature = sign(null, Buffer.from(preimage), privateKey).toString("base64url");
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    "X-Open-Android-Intelligence-Protocol": "2.1",
    "X-Open-Android-Intelligence-Account": session.accountId,
    "X-Open-Android-Intelligence-Device": session.deviceId,
    "X-Open-Android-Intelligence-Session": session.sessionId,
    "X-Open-Android-Intelligence-Request-Id": requestId,
    "X-Open-Android-Intelligence-Timestamp": timestamp,
    "X-Open-Android-Intelligence-Nonce": nonce,
    "X-Open-Android-Intelligence-Signature": signature,
    Accept: "application/json",
  };
  if (method !== "GET") headers["Idempotency-Key"] = requestId;
  if (body !== null) headers["Content-Type"] = "application/json";
  return { method, target: canonicalTarget, headers, body: (method === "GET" || method === "DELETE") && body === null ? undefined : bodyText };
};

const signedJson = async (method, target, body = null) => {
  const request = await signedFetch(method, target, body);
  const response = await fetch(`${baseUrl}${request.target}`, request);
  const text = await response.text();
  const json = JSON.parse(text);
  if (!response.ok) {
    throw new Error(`${method} ${target} 失败（${response.status}）：${json?.error?.code ?? text.slice(0, 200)}`);
  }
  return json.data;
};

const negotiationId = `neg_${randomBytes(8).toString("hex")}`;
const installationId = `install_smoke_${randomBytes(4).toString("hex")}`;
console.log(`→ 协商 ${baseUrl}`);
const negotiated = await postJson("/negotiate", {
  negotiationId,
  protocol: { major: 2, minor: 1 },
  client: { installationId, appVersion: "2.1.0", platform: "android", platformApi: 35 },
  features: {
    auth: ["password", "refresh"],
    messages: ["chat-v1"],
    attachments: ["staged-sha256-v1"],
    events: ["sse-cursor-v1"],
    deviceRequests: ["risk-queue-v1"],
    conversationUi: ["agent-command-catalog-v1", "generation-cancel-v1", "newline-v1", "conversation-management-v1"],
  },
  schemaHashes: { core: CORE_SCHEMA_HASH },
});
console.log(`  协议 ${negotiated.protocol.major}.${negotiated.protocol.minor}；能力 ${negotiated.features.conversationUi.join(", ")}`);
const deploymentId = negotiated.gatewayIdentity.deploymentId;

console.log(`→ 密码登录 ${username}`);
const credentials = await postJson(
  "/sessions/password",
  {
    negotiationId,
    username,
    password,
    installation: {
      installationId,
      displayName: "DSH smoke client",
      devicePublicKey,
    },
  },
  {},
);
Object.assign(session, {
  accountId: credentials.accountId,
  deviceId: credentials.deviceId,
  sessionId: credentials.sessionId,
  accessToken: credentials.accessToken,
});
console.log(`  账号 ${session.accountId} / 设备 ${session.deviceId}`);

if (args.includes("--cleanup")) {
  console.log("→ 清理测试会话");
  const list = await signedJson("GET", "/conversations?limit=100");
  for (const conversation of list.conversations) {
    try {
      const current = await signedJson("GET", `/conversations/${conversation.conversationId}/generations/current`);
      if (current.generation !== null) {
        await signedJson(
          "POST",
          `/conversations/${conversation.conversationId}/generations/${current.generation.generationId}/cancel`,
          { clientMessageId: `cleanup_cancel_${randomBytes(4).toString("hex")}` },
        );
      }
      await signedJson("DELETE", `/conversations/${conversation.conversationId}`);
      console.log(`  已删除 ${conversation.conversationId} ${conversation.title ?? ""}`);
    } catch (error) {
      console.log(`  跳过 ${conversation.conversationId}: ${error.message}`);
    }
  }
  process.exit(0);
}

console.log("→ 配对状态");
const pairing = await signedJson("GET", "/pairings/current");
console.log(`  grantRevision=${pairing.grantRevision} grantDigest=${pairing.grantDigest}`);
if (!Number.isSafeInteger(pairing.grantRevision)) {
  throw new Error("配对状态缺少合法的 grantRevision");
}
if (pairing.grantDigest === null) {
  const published = await signedJson("POST", "/pairings/current/capabilities", {
    bindings: [],
    localGrantRevision: 1,
    expectedGrantRevision: pairing.grantRevision,
  });
  if (!String(published.grantDigest).startsWith("sha256:")) {
    throw new Error(`能力发布摘要非法：${published.grantDigest}`);
  }
  console.log(`  能力发布成功 digest=${String(published.grantDigest).slice(0, 20)}…`);
}

console.log("→ 基线快照");
const snapshot = await signedJson("GET", "/sync/snapshot");
if (typeof snapshot.baselineCursor !== "string") throw new Error("基线快照缺少 baselineCursor");
console.log(`  baselineCursor=${snapshot.baselineCursor} 会话数=${snapshot.conversations.length}`);

console.log("→ 命令目录");
const catalog = await signedJson("GET", "/commands?languageCode=zh-CN");
if (typeof catalog.catalogVersion !== "string") throw new Error("命令目录缺少 catalogVersion");
console.log(`  ${catalog.commands.length} 条命令（${catalog.catalogVersion}）`);

console.log("→ 创建会话");
const created = await signedJson("POST", "/conversations", {
  clientConversationId: `cconv_smoke_${randomBytes(4).toString("hex")}`,
  title: "DSH smoke test",
});
const conversationId = created.conversation.conversationId;
console.log(`  会话 ${conversationId}`);

// 先开 SSE，避免漏掉首发事件。
const eventsRequest = await signedFetch("GET", "/events");
const eventsResponse = await fetch(`${baseUrl}${eventsRequest.target}`, {
  method: "GET",
  headers: { ...eventsRequest.headers, Accept: "text/event-stream" },
});
if (!eventsResponse.ok || eventsResponse.body === null) {
  throw new Error(`/events 失败（${eventsResponse.status}）`);
}
console.log("→ SSE 已连接");

const seen = [];
const decoder = new TextDecoder();
let buffer = "";
const completed = new Promise((resolve) => {
  (async () => {
    for await (const chunk of eventsResponse.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split("\n");
        const eventName = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
        const dataLine = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
        if (eventName.length === 0) continue;
        const payload = JSON.parse(dataLine);
        seen.push(eventName);
        if (eventName === "conversation.message.delta") {
          process.stdout.write(`\r  流式 ${payload.payload.text.length} 字...`);
        }
        if (eventName === "conversation.message.completed") {
          console.log(`\n  完成消息 ${payload.payload.messageId}: ${payload.payload.text.slice(0, 120)}`);
        }
        if (eventName === "conversation.message.status" && payload.payload.status === "completed") {
          console.log(`  用户消息终态 completed（revision ${payload.payload.revision}）`);
          resolve();
        }
        if (eventName === "conversation.message.status" && payload.payload.status === "failed") {
          console.log(`  用户消息失败：${payload.payload.errorCode}`);
          resolve();
        }
      }
    }
  })().catch((error) => {
    console.error(`SSE 读取失败：${error.message}`);
    resolve();
  });
});

console.log(`→ 发送消息：${prompt.slice(0, 40)}...`);
const accepted = await signedJson("POST", `/conversations/${conversationId}/messages`, {
  clientMessageId: `cmsg_smoke_${randomBytes(4).toString("hex")}`,
  text: prompt,
  attachments: [],
});
console.log(`  已接受 messageId=${accepted.message.messageId} generationId=${accepted.message.generationId}`);

const timer = setTimeout(() => {
  console.error(`\n超时：${timeoutMs}ms 内未看到终态；已见事件 ${[...new Set(seen)].join(", ")}`);
  process.exit(3);
}, timeoutMs);
await completed;
clearTimeout(timer);

console.log("→ 读取历史");
const history = await signedJson("GET", `/conversations/${conversationId}/messages?limit=20`);
for (const message of history.messages) {
  console.log(`  [${message.sender}] ${String(message.text).slice(0, 100)}`);
}
console.log("→ 当前生成");
const current = await signedJson("GET", `/conversations/${conversationId}/generations/current`);
console.log(`  ${JSON.stringify(current)}`);
console.log(`\n✅ 冒烟通过：deployment=${deploymentId} conversation=${conversationId} 事件=${[...new Set(seen)].join(", ")}`);
process.exit(0);
