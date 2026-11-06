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

async function host({ legacyUserWrapper = false, terminalReason = "completed", instanceId } = {}) {
  const listeners = new Map();
  const calls = [];
  const records = [{ header: { id: "terminal", createdAt: 1000 }, live: false, persisted: true }];
  const query = {
    listSessions: async () => { calls.push("listSessions"); return records; },
    readTitle: async (id) => ({ title: "Native " + id, updatedAt: 2000 }),
    readSurface: async (id) => {
      const message = { id: "message", role: "user", content: [{ type: "text", text: "native history" }], source: { kind: "user" } };
      return { session: { id }, events: [{ type: "user/message", time: 3000, data: legacyUserWrapper ? { message } : message }] };
    },
  };
  const emit = (event, ...args) => { for (const listener of listeners.get(event) ?? []) listener(...args); };
  const controller = {
    create: async ({ sessionId }) => { calls.push(["create", sessionId]); records.push({ header: { id: sessionId, createdAt: 4000 } }); return { sessionId }; },
    rename: async (value) => { calls.push(["rename", value]); return { title: value.title }; },
    cancel: () => ({ accepted: true }),
    prompt: async (value) => {
      calls.push(["prompt", value]);
      const session = { id: value.sessionId };
      // A concurrent terminal turn must not complete this App request.
      emit("session/event", session, { type: "turn/start", data: { turn: 3 } });
      emit("session/event", session, { type: "turn/end", data: { turn: 3, reason: { kind: "completed" } } });
      emit("session/event", session, { type: "turn/start", data: { turn: 4 } });
      const message = { id: "submitted", role: "user", content: value.content, source: { kind: "user", rpcId: value.requestId } };
      emit("session/event", session, { type: "user/message", data: legacyUserWrapper ? { message } : message });
      emit("agent/assistant-stream", { agent: { session }, frame: { type: "start", attemptId: "attempt", turn: 4, step: 0, revision: 0 } });
      // Native chunks carry attemptId, not turn; the start binds its turn.
      emit("agent/assistant-stream", { agent: { session }, frame: { type: "chunk", attemptId: "attempt", index: 0, revision: 0, chunk: { type: "text-delta", index: 0, text: "native reply" } } });
      emit("session/event", session, { type: "assistant/message", data: { turn: 4, message: { content: [{ type: "text", text: "native reply" }] } } });
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
  it.each([undefined, "dsh-custom"])("握手返回真实在线状态及绑定挑战的签名（实例 %s）", async (instanceId) => {
    const h = await host({ instanceId });
    const challenge = "a".repeat(64);
    const response = await h.request("/handshake", "POST", { challenge });
    expect(response.status).toBe(200);
    const result = await response.json();
    const expectedId = instanceId ?? process.env.OAI_DSH_INSTANCE_ID ?? "dsh";
    expect(result).toMatchObject({ instanceId: expectedId, sessionScope: "deployment", online: true });
    const capabilities = Object.fromEntries(Object.entries(result.capabilities).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const payload = { capabilities, challenge, instanceId: expectedId, online: true, sessionScope: "deployment" };
    expect(result.proof).toBe(createHmac("sha256", token).update("oai-agent-handshake-v1\0").update(JSON.stringify(payload)).digest("hex"));
    expect(h.calls).toEqual(["listSessions"]);
    const changed = await (await h.request("/handshake", "POST", { challenge: "b".repeat(64) })).json();
    expect(changed.proof).not.toBe(result.proof);
  });
  it("握手在访问宿主前拒绝无认证和无效挑战", async () => {
    const h = await host();
    expect((await fetch(h.origin + "/handshake", { method: "POST" })).status).toBe(401);
    for (const body of [{}, { challenge: "bad" }, { challenge: "A".repeat(64) }, { challenge: "a".repeat(64), extra: true }]) {
      expect((await h.request("/handshake", "POST", body)).status).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });
  it("真实宿主查询失败时拒绝返回成功握手", async () => {
    const h = await host();
    h.query.listSessions = async () => { throw new Error("测试宿主不可用"); };
    const response = await h.request("/handshake", "POST", { challenge: "a".repeat(64) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "AGENT_UNAVAILABLE" });
  });
  it("uses only the installed host's complete native corpus and sees subsequent terminal sessions", async () => {
    const h = await host();
    expect((await (await h.request("/sessions")).json()).sessions.map((s) => s.id)).toEqual(["terminal"]);
    h.records.push({ header: { id: "later-cli", createdAt: 5000 } });
    expect((await (await h.request("/sessions")).json()).sessions.map((s) => s.id)).toEqual(["terminal", "later-cli"]);
    const history = await (await h.request("/sessions/terminal/history")).json();
    expect(history.messages[0].text).toBe("native history");
    expect((await h.request("/sessions/unknown/history")).status).toBe(404);
  });
  it("requires the Core-only token before touching any native data", async () => {
    const h = await host();
    expect((await fetch(h.origin + "/sessions")).status).toBe(401);
    expect(h.calls).toEqual([]);
    expect((await h.request("/sessions?accountId=other")).status).toBe(400);
  });
  it("preserves compatibility with legacy wrapped user events", async () => {
    const h = await host({ legacyUserWrapper: true });
    const history = await (await h.request("/sessions/terminal/history")).json();
    expect(history.messages).toMatchObject([{ id: "message", role: "user", text: "native history" }]);
    const events = (await (await h.request("/sessions/terminal/messages", "POST", { text: "hello" })).text()).trim().split("\n").map(JSON.parse);
    expect(events.at(-1)).toEqual({ type: "done", text: "native reply" });
  });
  it("creates and sends through the actual controller signatures and streams only the correlated native turn", async () => {
    const h = await host();
    const created = await (await h.request("/sessions", "POST", { title: "new" })).json();
    expect(h.calls.some((item) => item[0] === "create" && item[1] === created.session.id)).toBe(true);
    const result = (await (await h.request("/sessions/terminal/messages", "POST", { text: "hello" })).text()).trim().split("\n").map(JSON.parse);
    expect(result).toEqual([{ type: "delta", text: "native reply" }, { type: "done", text: "native reply" }]);
    const prompt = h.calls.find((item) => item[0] === "prompt")[1];
    expect(prompt).toMatchObject({ sessionId: "terminal", mode: "queue", content: [{ type: "text", text: "hello" }] });
    expect(Object.keys(prompt).sort()).toEqual(["content", "mode", "requestId", "sessionId"]);
    expect([...h.listeners.values()].every((value) => value.size === 0)).toBe(true);
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
    expect(events.at(-1)).toEqual({ type: "done", text: "native reply" });
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
    expect((await h.request("/sessions/terminal/delete", "POST", {})).status).toBe(409);
    h.query.listSessions = async () => { throw new Error("backend unavailable"); };
    expect((await h.request("/status")).status).toBe(503);
  });
  it.each([
    ["blocked", "AGENT_BLOCKED"], ["max-tokens", "AGENT_MAX_TOKENS"],
    ["interrupted", "OUTCOME_UNKNOWN"], ["error", "AGENT_FAILED"], ["aborted", "CANCELLED"],
  ])("does not report a %s native turn as successful", async (terminalReason, code) => {
    const h = await host({ terminalReason });
    const events = (await (await h.request("/sessions/terminal/messages", "POST", { text: "hello" })).text()).trim().split("\n").map(JSON.parse);
    expect(events.at(-1)).toEqual({ type: "error", code });
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
  it("validates its standard plugin configuration", () => {
    expect(Config["~standard"].validate({ port: -1 }).issues).toBeDefined();
    expect(Config["~standard"].validate({}).value.port).toBe(8791);
    expect(Config["~standard"].validate({ instanceId: "bad/id" }).issues).toBeDefined();
  });
});
