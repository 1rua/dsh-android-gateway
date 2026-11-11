import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { createSessionHandler } from "../src/index.js";
import { cancelGeneration, findGeneration, projectGenerations } from "../src/generation.js";

const token = "test-only-generation-token-123456789012";
const prefix = "/oai/session-adapter/v1/sessions/one";
const input = (id = "native-user", rpcId = "stable-client") => ({ id, role: "user", source: { kind: "user", rpcId }, content: [{ type: "text", text: "合成输入" }] });
const runningLog = () => [
  { seq: 0, type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [input()] } },
  { seq: 1, type: "turn/start", data: { turn: 7 } },
  { seq: 2, type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, removedCount: 1, inserted: [] } },
];
function fixture(events = runningLog(), status = "running", config = {}) {
  const agent = { status, session: { snapshotEvents: () => events }, cancel: vi.fn() };
  let live = agent;
  const listeners = new Map();
  const services = {
    sessionQuery: { listSessions: async () => [{ header: { id: "one", createdAt: 1000 } }], readSession: async () => ({ events }), readSurface: async () => ({ events: [] }) },
    sessionController: { prompt: vi.fn(async () => ({ accepted: true })) },
    agents: { get: () => live },
  };
  const handler = createSessionHandler({ get: (name) => services[name], on: (name, listener) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(listener);
    return () => listeners.get(name).delete(listener);
  } }, config, token);
  async function request(action = "/generation", method = "GET", body) {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
      method, url: prefix + action, headers: { authorization: `Bearer ${token}` },
    });
    const res = Object.assign(new EventEmitter(), {
      frames: [],
      writeHead(statusCode) { this.status = statusCode; this.headersSent = true; },
      write(value) { this.frames.push(JSON.parse(value)); return true; },
      end(value) { if (value !== undefined) this.body = JSON.parse(value); this.writableEnded = true; },
    });
    await handler(req, res);
    return res;
  }
  const emit = (event) => { events.push(event); for (const listener of listeners.get("session/event") ?? []) listener({ id: "one" }, event); };
  return { request, agent, events, services, listeners, emit, setLive: (value) => { live = value; } };
}

it("受理后尚未写用户消息时通过持久inbox消费恢复同一代次", async () => {
  const h = fixture();
  const response = await h.request("/generation?clientMessageId=stable-client");
  expect(response.status).toBe(200);
  expect(response.body.generation).toMatchObject({ generationId: "dsh:one:message:native-user", conversationId: "one", clientMessageId: "stable-client", userMessageId: "native-user", state: "running", revision: 3 });
});
it("排队、运行及真实终态沿用已接纳的原生消息身份", async () => {
  const events = runningLog();
  const h = fixture(events.slice(0, 1), "idle");
  const queued = await h.request("/generation?clientMessageId=stable-client");
  expect(queued.body.generation).toMatchObject({ generationId: "dsh:one:message:native-user", state: "queued" });
  h.events.push(...events.slice(1), { seq: 3, type: "assistant/message", data: { turn: 7, message: { id: "native-reply", role: "assistant", content: [{ type: "text", text: "合成回复" }] } } }, { seq: 4, type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } });
  const completed = await h.request("/generation?clientMessageId=stable-client");
  expect(completed.body.generation).toMatchObject({ generationId: queued.body.generation.generationId, state: "completed", messageId: "native-reply", text: "合成回复", revision: 5 });
  expect((await h.request()).body.generation).toBeNull();
});
it("宿主未附着且没有原生终态时诚实返回未知", async () => {
  const h = fixture();
  h.setLive(undefined);
  expect((await h.request()).body.generation).toMatchObject({ state: "unknown" });
});
it("精确取消同步比较当前原生轮次并保留inbox", async () => {
  const h = fixture();
  const response = await h.request("/cancel", "POST", { value: { generationId: "dsh:one:message:native-user" } });
  expect(response.status).toBe(200);
  expect(h.agent.cancel).toHaveBeenCalledExactlyOnceWith({ kind: "user" }, { keepInbox: true });
  expect(response.body).toMatchObject({ outcome: "unknown", generationId: "dsh:one:message:native-user" });
});
it("过期终态、排队目标与外部新轮次均不误取消", async () => {
  const h = fixture();
  h.events.push({ seq: 3, type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } }, { seq: 4, type: "turn/start", data: { turn: 8 } });
  const old = await h.request("/cancel", "POST", { value: { generationId: "dsh:one:message:native-user" } });
  expect(old.body.outcome).toBe("already_completed");
  h.events.push({ seq: 5, type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [input("queued-user", "queued-client")] } });
  await h.request("/cancel", "POST", { value: { generationId: "dsh:one:message:queued-user" } });
  expect(h.agent.cancel).not.toHaveBeenCalled();
});
it("同步取消原语对缺失身份和被替换的Agent拒绝副作用", () => {
  const cancel = vi.fn();
  const first = { status: "running", session: { snapshotEvents: runningLog }, cancel };
  expect(cancelGeneration("one", undefined, () => first).outcome).toBe("unknown");
  expect(cancelGeneration("one", "", () => first).outcome).toBe("unknown");
  let reads = 0;
  const replacement = { ...first };
  const result = cancelGeneration("one", "dsh:one:message:native-user", () => ++reads === 1 ? first : replacement);
  expect(result.outcome).toBe("unknown");
  expect(cancel).not.toHaveBeenCalled();
});
it("同一原生轮次中的多个用户保持独立来源且关联共同终态", () => {
  const events = runningLog();
  events[0].data.inserted.push(input("steering-user", "steering-client"));
  events[2].data.removedCount = 2;
  events.push({ seq: 3, type: "assistant/message", data: { turn: 7, message: { id: "answer", content: [{ type: "text", text: "共同回复" }] } } },
    { seq: 4, type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } });
  const projection = projectGenerations("one", events);
  for (const clientMessageId of ["stable-client", "steering-client"]) expect(findGeneration(projection, { clientMessageId })).toMatchObject({ nativeTurn: 7, state: "completed", messageId: "answer" });
  expect(findGeneration(projection, { clientMessageId: "stable-client", generationId: "dsh:one:message:steering-user" })).toBeNull();
});
it("没有用户事件的外部活动轮次仍阻挡误判空闲", async () => {
  const h = fixture([{ seq: 0, type: "turn/start", data: { turn: 8 } }]);
  expect((await h.request()).body.generation).toMatchObject({ generationId: "dsh:one:turn:8", state: "running" });
});
it("历史读取完整日志，仅最终助手回复关联原生客户端身份", async () => {
  const h = fixture();
  h.events.push({ seq: 3, time: 1000, type: "user/message", data: input() },
    { seq: 4, time: 2000, type: "assistant/message", data: { turn: 7, message: { id: "intermediate", role: "assistant", content: [{ type: "text", text: "中间步骤" }] } } },
    { seq: 5, time: 3000, type: "assistant/message", data: { turn: 7, message: { id: "final", role: "assistant", content: [{ type: "text", text: "最终回复" }] } } },
    { seq: 6, type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } });
  const response = await h.request("/history");
  expect(response.body.messages).toHaveLength(3);
  expect(response.body.messages[0]).toMatchObject({ clientMessageId: "stable-client", generationId: "dsh:one:message:native-user", state: "completed", contentRevision: 7 });
  expect(response.body.messages[1]).not.toHaveProperty("clientMessageId");
  expect(response.body.messages[1]).not.toHaveProperty("generationId");
  expect(response.body.messages[2]).toMatchObject({ clientMessageId: "stable-client", generationId: "dsh:one:message:native-user", state: "completed" });
});
it("重复提交已完成身份立即重放权威终态，宿主不再受理", async () => {
  const h = fixture();
  h.events.push({ seq: 3, type: "assistant/message", data: { turn: 7, message: { id: "answer", role: "assistant", content: [{ type: "text", text: "完成回复" }] } } },
    { seq: 4, type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } });
  const result = await h.request("/messages", "POST", { text: "同一输入", clientMessageId: "stable-client" });
  expect(result.frames[0]).toMatchObject({ type: "generation", generationId: "dsh:one:message:native-user" });
  expect(result.frames[0]).not.toHaveProperty("state");
  expect(result.frames.at(-1)).toMatchObject({ type: "done", text: "完成回复", generationId: "dsh:one:message:native-user", userMessageId: "native-user", messageId: "answer" });
  expect(h.services.sessionController.prompt).not.toHaveBeenCalled();
});
it("重复提交活动身份只附着原生观察，未知身份不重投", async () => {
  const h = fixture();
  const task = h.request("/messages", "POST", { text: "同一输入", clientMessageId: "stable-client" });
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  h.emit({ seq: 3, type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } });
  const observed = await task;
  expect(observed.frames[0]).toMatchObject({ type: "generation", state: "running", revision: 3 });
  expect(observed.frames.at(-1)).toMatchObject({ type: "done", userMessageId: "native-user" });
  expect(h.services.sessionController.prompt).not.toHaveBeenCalled();
  const unknown = fixture();
  unknown.setLive(undefined);
  const response = await unknown.request("/messages", "POST", { text: "同一输入", clientMessageId: "stable-client" });
  expect(response.frames.at(-1)).toMatchObject({ type: "error", code: "OUTCOME_UNKNOWN", state: "unknown" });
  expect(unknown.services.sessionController.prompt).not.toHaveBeenCalled();
});
it("长轮询在注册后重读，补回注册窗口内的原生日志变化", async () => {
  const h = fixture();
  let reads = 0;
  h.setLive(undefined);
  h.services.sessionQuery.readSession = async () => {
    reads++;
    if (reads === 1) {
      const snapshot = [...h.events];
      queueMicrotask(() => h.events.push({ seq: 3, type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } }));
      return { events: snapshot };
    }
    return { events: h.events };
  };
  const response = await h.request("/generation?clientMessageId=stable-client&afterRevision=3&waitMs=1000");
  expect(response.body.generation).toMatchObject({ state: "completed", revision: 4 });
  expect([...h.listeners.values()].every((value) => value.size === 0)).toBe(true);
});
it("重复身份预查挂起时仍按观察期限清理且不重新入队", async () => {
  const h = fixture(undefined, "running", { promptTimeoutMs: 20 });
  let completeRead;
  h.services.sessionQuery.readSession = () => new Promise((resolve) => { completeRead = resolve; });
  const response = await h.request("/messages", "POST", { text: "合成输入", clientMessageId: "stable-client" });
  expect(response.frames.at(-1)).toMatchObject({ type: "error", code: "OUTCOME_UNKNOWN", state: "unknown" });
  expect(h.services.sessionController.prompt).not.toHaveBeenCalled();
  expect([...h.listeners.values()].every((value) => value.size === 0)).toBe(true);
  completeRead({ events: [] });
  await new Promise((resolve) => setImmediate(resolve));
  expect(h.services.sessionController.prompt).not.toHaveBeenCalled();
});
