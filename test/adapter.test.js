import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Config, createSessionHandler } from "../src/index.js";

const token = "test-only-dsh-bridge-token-1234567890";
const prefix = "/oai/session-adapter/v1";
const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function host({ legacyUserWrapper = false, terminalReason = "completed", omitMessageIdentity = false, instanceId } = {}) {
  const listeners = new Map();
  const calls = [];
  const persisted = [];
  const records = [{ header: { id: "terminal", createdAt: 1000 }, live: false, persisted: true }];
  const query = {
    listSessions: async () => { calls.push("listSessions"); return records; },
    readTitle: async (id) => ({ title: "Native " + id, updatedAt: 2000 }),
    readSurface: async (id) => {
      const message = { id: "message", role: "user", content: [{ type: "text", text: "native history" }], source: { kind: "user" } };
      return { session: { id }, events: [{ type: "user/message", time: 3000, data: legacyUserWrapper ? { message } : message }, ...persisted] };
    },
  };
  const emit = (event, ...args) => { for (const listener of listeners.get(event) ?? []) listener(...args); };
  const controller = {
    create: async ({ sessionId }) => { calls.push(["create", sessionId]); records.push({ header: { id: sessionId, createdAt: 4000 } }); return { sessionId }; },
    rename: async (value) => { calls.push(["rename", value]); return { title: value.title }; },
    cancel: (value) => { calls.push(["cancel", value]); return { accepted: true }; },
    prompt: async (value) => {
      calls.push(["prompt", value]);
      const session = { id: value.sessionId };
      // 其他终端轮次不能完成本次 App 提交。
      emit("session/event", session, { type: "turn/start", data: { turn: 3 } });
      emit("session/event", session, { type: "turn/end", data: { turn: 3, reason: { kind: "completed" } } });
      emit("session/event", session, { type: "turn/start", data: { turn: 4 } });
      const message = { id: "submitted", role: "user", content: value.content, source: { kind: "user", rpcId: value.requestId } };
      const userEvent = { type: "user/message", time: 4000, data: legacyUserWrapper ? { message } : message };
      persisted.push(userEvent);
      emit("session/event", session, userEvent);
      emit("agent/assistant-stream", { agent: { session }, frame: { type: "start", attemptId: "attempt", turn: 4, step: 0, revision: 0 } });
      // 原生增量只有 attemptId，开始帧负责绑定轮次。
      emit("agent/assistant-stream", { agent: { session }, frame: { type: "chunk", attemptId: "attempt", index: 0, revision: 0, chunk: { type: "text-delta", index: 0, text: "native reply" } } });
      const reply = { ...(omitMessageIdentity ? {} : { id: "native-reply", role: "assistant" }), content: [{ type: "text", text: "native reply" }] };
      const replyEvent = { type: "assistant/message", time: 5000, data: { turn: 4, message: reply } };
      persisted.push(replyEvent);
      emit("session/event", session, replyEvent);
      emit("session/event", session, { type: "turn/end", data: { turn: 4, reason: { kind: terminalReason } } });
      return { accepted: true };
    },
  };
  const ctx = {
    get: (name) => ({ sessionQuery: query, sessionController: controller })[name],
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return () => listeners.get(event).delete(listener);
    },
  };
  const server = createServer(createSessionHandler(ctx, { instanceId }, token));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}${prefix}`;
  const request = (path, method = "GET", body) => fetch(origin + path, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { request, origin, records, calls, listeners, query, controller };
}

describe("DSH native Session Adapter", () => {
  it.each(["blocked", "max-tokens"])("确定失败的原生终态诊断不伪装未知：%s", async (terminalReason) => {
    const h = await host({ terminalReason });
    const previous = process.env.OAI_DSH_ADAPTER_DIAGNOSTICS;
    process.env.OAI_DSH_ADAPTER_DIAGNOSTICS = "1";
    const originalWrite = process.stderr.write;
    const diagnostics = [];
    process.stderr.write = function (chunk, ...args) {
      if (String(chunk).startsWith("oai_native ")) diagnostics.push(JSON.parse(String(chunk).slice(11)));
      else return originalWrite.call(this, chunk, ...args);
      return true;
    };
    try {
      const response = await h.request("/sessions/terminal/messages", "POST", { text: "合成终态诊断" });
      await response.text();
      expect(diagnostics.find((item) => item.stage === "adapter.dsh.native_terminal").state).toBe("failed");
    } finally {
      process.stderr.write = originalWrite;
      if (previous === undefined) delete process.env.OAI_DSH_ADAPTER_DIAGNOSTICS;
      else process.env.OAI_DSH_ADAPTER_DIAGNOSTICS = previous;
    }
  });

  it("向宿主传入有效受理信号并保留原生完成结果", async () => {
    const h = await host();
    const nativePrompt = h.controller.prompt;
    let admissionSignal;
    h.controller.prompt = (input, signal) => {
      admissionSignal = signal;
      signal.throwIfAborted();
      return nativePrompt(input);
    };
    const events = (await (await h.request("/sessions/terminal/messages", "POST", { text: "hello" })).text()).trim().split("\n").map(JSON.parse);
    expect(admissionSignal).toBeInstanceOf(AbortSignal);
    expect(admissionSignal.aborted).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", userMessageId: "submitted" });
  });
  it("以迭代摘要保留十五万条事件的长会话与普通会话", async () => {
    const h = await host();
    h.records.push({ header: { id: "long-history", createdAt: 1000 } });
    const nativeSurface = h.query.readSurface;
    h.query.readSurface = async (id) => id === "long-history"
      ? { events: Array.from({ length: 150_000 }, (_, index) => ({ time: 4000 + index })) }
      : nativeSurface(id);
    const response = await h.request("/sessions");
    expect(response.status).toBe(200);
    expect((await response.json()).sessions).toEqual([
      { id: "terminal", title: "Native terminal", updatedAt: new Date(3000).toISOString(), archived: false },
      { id: "long-history", title: "Native long-history", updatedAt: new Date(153_999).toISOString(), archived: false },
    ]);
  });
  it.each([false, true])("从历史原生来源恢复客户端身份，兼容旧包装=%s", async (legacyUserWrapper) => {
    const h = await host({ legacyUserWrapper });
    await (await h.request("/sessions/terminal/messages", "POST", { text: "hello", clientMessageId: "stable-client" })).text();
    const messages = (await (await h.request("/sessions/terminal/history")).json()).messages;
    expect(messages.find((message) => message.id === "submitted")).toMatchObject({
      id: "submitted", role: "user", clientMessageId: "stable-client",
    });
    expect(messages.find((message) => message.id === "native-reply")).not.toHaveProperty("clientMessageId");
    expect(messages.find((message) => message.id === "message")).not.toHaveProperty("clientMessageId");
  });
  it("signs a fresh challenge with the stable instance and actual host capabilities", async () => {
    const h = await host({ instanceId: "dsh-instance" });
    const challenge = "a".repeat(64);
    const result = await (await h.request("/handshake", "POST", { challenge })).json();
    expect(result).toMatchObject({ instanceId: "dsh-instance", sessionScope: "deployment", online: true });
    const capabilities = Object.fromEntries(Object.entries(result.capabilities).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const payload = { capabilities, challenge, instanceId: "dsh-instance", online: true, sessionScope: "deployment" };
    expect(result.proof).toBe(createHmac("sha256", token).update("oai-agent-handshake-v1\0").update(JSON.stringify(payload)).digest("hex"));
    expect((await h.request("/handshake", "POST", { challenge: "bad" })).status).toBe(400);
    const anonymous = await fetch(h.origin + "/handshake", { method: "POST" });
    expect(anonymous.status).toBe(401);
    const changed = await (await h.request("/handshake", "POST", { challenge: "b".repeat(64) })).json();
    expect(changed.proof).not.toBe(result.proof);
  });
  it("uses only the installed host's complete native corpus and sees subsequent terminal sessions", async () => {
    const h = await host();
    expect((await (await h.request("/sessions")).json()).sessions.map((s) => s.id)).toEqual(["terminal"]);
    h.records.push({ header: { id: "later-cli", createdAt: 5000 } });
    expect((await (await h.request("/sessions")).json()).sessions.map((s) => s.id)).toEqual(["terminal", "later-cli"]);
    const history = await (await h.request("/sessions/terminal/history")).json();
    expect(history.messages[0].text).toBe("native history");
    const missing = await h.request("/sessions/unknown/history");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: "SESSION_NOT_FOUND" });
  });
  it("requires the Core-only token before touching any native data", async () => {
    const h = await host();
    const unauthorized = await fetch(h.origin + "/sessions");
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ code: "AUTHENTICATION_REQUIRED" });
    expect(h.calls).toEqual([]);
    const invalid = await h.request("/sessions?accountId=other");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ code: "SCHEMA_INVALID" });
  });
  it("preserves compatibility with legacy wrapped user events", async () => {
    const h = await host({ legacyUserWrapper: true });
    const history = await (await h.request("/sessions/terminal/history")).json();
    expect(history.messages).toMatchObject([{ id: "message", role: "user", text: "native history" }]);
    const events = (await (await h.request("/sessions/terminal/messages", "POST", { text: "hello" })).text()).trim().split("\n").map(JSON.parse);
    expect(events.at(-1)).toEqual({ type: "done", text: "native reply", messageId: "native-reply", userMessageId: "submitted" });
  });
  it("creates and sends through the actual controller signatures and streams only the correlated native turn", async () => {
    const h = await host();
    const created = await (await h.request("/sessions", "POST", { title: "new" })).json();
    expect(h.calls.some((item) => item[0] === "create" && item[1] === created.session.id)).toBe(true);
    const result = (await (await h.request("/sessions/terminal/messages", "POST", { text: "hello" })).text()).trim().split("\n").map(JSON.parse);
    expect(result).toEqual([{ type: "delta", text: "native reply" }, { type: "done", text: "native reply", messageId: "native-reply", userMessageId: "submitted" }]);
    const prompt = h.calls.find((item) => item[0] === "prompt")[1];
    expect(prompt).toMatchObject({ sessionId: "terminal", mode: "queue", content: [{ type: "text", text: "hello" }] });
    expect(Object.keys(prompt).sort()).toEqual(["content", "mode", "requestId", "sessionId"]);
    expect([...h.listeners.values()].every((value) => value.size === 0)).toBe(true);
  });
  it("aligns completed native identities with a fresh history projection", async () => {
    const h = await host();
    const events = (await (await h.request("/sessions/terminal/messages", "POST", { text: "hello" })).text()).trim().split("\n").map(JSON.parse);
    const done = events.at(-1);
    const history = (await (await h.request("/sessions/terminal/history")).json()).messages;
    expect(done.messageId).toBe("native-reply");
    expect(done.userMessageId).toBe("submitted");
    expect(history.find((message) => message.id === done.messageId)).toMatchObject({ role: "assistant", text: done.text });
    expect(history.find((message) => message.id === done.userMessageId)).toMatchObject({ role: "user", text: "hello" });
  });
  it("preserves an older stream that has no assistant identity without inventing one", async () => {
    const h = await host({ omitMessageIdentity: true });
    const events = (await (await h.request("/sessions/terminal/messages", "POST", { text: "hello" })).text()).trim().split("\n").map(JSON.parse);
    expect(events.at(-1)).toEqual({ type: "done", text: "native reply", userMessageId: "submitted" });
    expect(events.at(-1)).not.toHaveProperty("messageId");
  });
  it.each([
    ["70k ASCII", "a".repeat(70000)],
    ["multibyte UTF-8", "消息".repeat(12000)],
    ["one byte below 1 MiB", "😀".repeat(262141)],
  ])("accepts a %s request above the old 64 KiB bridge limit", async (_, text) => {
    const h = await host();
    const bytes = Buffer.byteLength(JSON.stringify({ text }));
    expect(bytes).toBeGreaterThan(65536);
    expect(bytes).toBeLessThan(1024 * 1024);
    const response = await h.request("/sessions/terminal/messages", "POST", { text });
    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split("\n").map(JSON.parse);
    expect(events.at(-1)).toEqual({ type: "done", text: "native reply", messageId: "native-reply", userMessageId: "submitted" });
    expect(h.calls.filter((item) => item[0] === "prompt")).toHaveLength(1);
    expect(h.calls.find((item) => item[0] === "prompt")[1].content).toEqual([{ type: "text", text }]);
    expect(h.records.map((record) => record.header.id)).toEqual(["terminal"]);
  });
  it.each([0, 1])("rejects a request at 1 MiB plus %i bytes before starting a native turn or stream", async (extra) => {
    const h = await host();
    const text = "😀".repeat(262141) + "a".repeat(1 + extra);
    expect(Buffer.byteLength(JSON.stringify({ text }))).toBe(1024 * 1024 + extra);
    const response = await h.request("/sessions/terminal/messages", "POST", { text });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ code: "PAYLOAD_TOO_LARGE" });
    expect(h.calls.some((item) => item[0] === "prompt")).toBe(false);
    expect(h.listeners.size).toBe(0);
    expect(h.records.map((record) => record.header.id)).toEqual(["terminal"]);
  });
  it("reports real query failure offline and never advertises unsupported deletion/archive", async () => {
    const h = await host();
    let status = await (await h.request("/status")).json();
    expect(status.online).toBe(true);
    expect(status.capabilities.archive).toBe(false);
    expect(status.capabilities.delete).toBe(false);
    expect(status.capabilities.cancel).toBe(false);
    const unsupported = await h.request("/sessions/terminal/delete", "POST", {});
    expect(unsupported.status).toBe(409);
    expect(await unsupported.json()).toEqual({ code: "UNSUPPORTED_CAPABILITY" });
    h.query.listSessions = async () => { throw new Error("backend unavailable"); };
    const offline = await h.request("/status");
    expect(offline.status).toBe(503);
    expect(await offline.json()).toEqual({ code: "AGENT_UNAVAILABLE" });
  });
  it("cannot let delayed or repeated cancel requests interrupt a newer host turn", async () => {
    const h = await host();
    // 旧版仅按会话取消会影响当前轮次。
    for (const generationId of ["old-turn", "current-turn", "current-turn"]) {
      const response = await h.request("/sessions/terminal/cancel", "POST", { value: { generationId } });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: "UNSUPPORTED_CAPABILITY" });
    }
    expect(h.calls.filter((call) => call[0] === "cancel")).toEqual([]);
  });
  it.each([
    ["blocked", "AGENT_BLOCKED"], ["max-tokens", "AGENT_MAX_TOKENS"],
    ["interrupted", "OUTCOME_UNKNOWN"], ["error", "AGENT_FAILED"], ["aborted", "CANCELLED"],
  ])("does not report a %s native turn as successful", async (terminalReason, code) => {
    const h = await host({ terminalReason });
    const events = (await (await h.request("/sessions/terminal/messages", "POST", { text: "hello" })).text()).trim().split("\n").map(JSON.parse);
    expect(events.at(-1)).toEqual({ type: "error", code, ...(code === "OUTCOME_UNKNOWN" ? { state: "unknown" } : {}) });
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
  it("validates its standard plugin configuration", () => {
    expect(Config["~standard"].validate({ port: -1 }).issues).toBeDefined();
    expect(Config["~standard"].validate({}).value.port).toBe(8791);
  });
});
