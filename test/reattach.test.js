import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { createSessionHandler } from "../src/index.js";

const token = "synthetic-stream-reattach-token-123456789012";
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) {
  const deadline = performance.now() + 500;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("合成观察未在期限内满足条件");
    await tick();
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(config = {}) {
  const events = [], listeners = new Map(), receipts = [];
  const session = { id: "one", snapshotEvents: () => events };
  const agent = { status: "idle", session, cancel: vi.fn() };
  let live = agent;
  const controller = { prompt: vi.fn((input, signal) => {
    signal.throwIfAborted();
    const receipt = deferred(); receipts.push({ input, ...receipt }); return receipt.promise;
  }) };
  const emit = (type, data) => {
    const event = { seq: events.length, time: 1000 + events.length, type, data };
    events.push(event);
    for (const listener of listeners.get("session/event") ?? []) listener(session, event);
  };
  const services = { agents: { get: () => live }, sessionController: controller,
    sessionQuery: { listSessions: async () => [{ header: { id: "one", createdAt: 1000 } }],
      readSession: async () => ({ events }), readSurface: async () => ({ events }) } };
  const ctx = { get: (name) => services[name],
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener); return () => listeners.get(name).delete(listener);
    } };
  const handler = createSessionHandler(ctx, { promptTimeoutMs: 100, observationTimeoutMs: 500, drainTimeoutMs: 200, ...config }, token,
    { heartbeatIntervalMs: 1000 });
  const request = (clientMessageId = "stable-client", slow = false, action = "messages") => {
    const req = Object.assign(Readable.from(action === "messages" ? [Buffer.from(JSON.stringify({ text: "合成输入", clientMessageId }))] : []), {
      method: action === "messages" ? "POST" : "GET", url: `/oai/session-adapter/v1/sessions/one/${action}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const res = Object.assign(new EventEmitter(), {
      frames: [], destroyed: false, writableEnded: false,
      writeHead(status) { this.status = status; this.headersSent = true; },
      write(line) { if (line.trim()) this.frames.push(JSON.parse(line)); return !slow; },
      end(body) { if (body !== undefined) this.body = JSON.parse(body); this.writableEnded = true; },
      destroy() { this.destroyed = true; this.emit("close"); },
    });
    return { res, task: handler(req, res) };
  };
  const accept = (index = 0) => {
    const { input } = receipts[index];
    const turn = index + 1; agent.status = "running";
    emit("turn/start", { turn });
    emit("user/message", { id: `native-user-${turn}`, role: "user", source: { kind: "user", rpcId: input.requestId }, content: input.content });
  };
  const delta = (text = "合成增量", turn = 1) => {
    const frames = [{ type: "start", turn, attemptId: `attempt-${turn}` },
      { type: "chunk", attemptId: `attempt-${turn}`, chunk: { type: "text-delta", text } }];
    for (const frame of frames) for (const listener of listeners.get("agent/assistant-stream") ?? []) listener({ agent, frame });
  };
  const finish = (kind = "completed", turn = 1) => {
    emit("assistant/message", { turn, message: { id: `native-reply-${turn}`, role: "assistant", content: [{ type: "text", text: "合成回复" }] } });
    agent.status = "idle"; emit("turn/end", { turn, reason: { kind } });
  };
  const count = () => [...listeners.values()].reduce((sum, value) => sum + value.size, 0);
  return { request, controller, receipts, accept, delta, finish, count, agent, events, emit, services, setLive: (value) => { live = value; } };
}

it("原观察仍存活时同身份可独立重附，任一观察关闭不影响其余观察或再次提交", async () => {
  const h = fixture(); const first = h.request();
  await until(() => h.receipts.length === 1); h.accept(); h.receipts[0].resolve({ accepted: true });
  await until(() => first.res.frames.some((frame) => frame.type === "generation"));
  const second = h.request();
  await until(() => second.res.frames.length > 0 || second.res.body !== undefined);
  expect(second.res.status).toBe(200); expect(second.res.frames[0]).toMatchObject({ type: "generation", generationId: "dsh:one:message:native-user-1" });
  first.res.destroy(); await first.task;
  const different = h.request("other-client"); await different.task;
  expect(different.res.body).toMatchObject({ code: "SESSION_BUSY" });
  const third = h.request(); await until(() => third.res.frames.length > 0 || third.res.body !== undefined);
  expect(third.res.frames[0]).toMatchObject({ type: "generation", generationId: "dsh:one:message:native-user-1" });
  h.delta(); await until(() => second.res.frames.some((frame) => frame.type === "delta"));
  expect(third.res.frames.some((frame) => frame.type === "delta")).toBe(true);
  h.finish(); await Promise.all([second.task, third.task]);
  expect(h.controller.prompt).toHaveBeenCalledTimes(1); expect(h.agent.cancel).not.toHaveBeenCalled(); expect(h.count()).toBe(0);
});

it("首次受理挂起时两个同身份观察共享提交，不同身份仍Busy，迟到接纳能到达全部观察", async () => {
  const h = fixture(); const first = h.request(); await until(() => h.receipts.length === 1);
  const second = h.request(); await tick();
  const other = h.request("other-client"); await other.task;
  expect(other.res.status).toBe(409); expect(other.res.body.code).toBe("SESSION_BUSY");
  expect(second.res.body).toBeUndefined(); expect(h.controller.prompt).toHaveBeenCalledTimes(1);
  h.accept(); h.delta(); h.receipts[0].resolve({ accepted: true }); h.finish();
  await Promise.all([first.task, second.task]);
  expect(second.res.frames.at(-1)).toMatchObject({ type: "done", userMessageId: "native-user-1" });
  expect(h.count()).toBe(0); expect(h.controller.prompt).toHaveBeenCalledTimes(1);
});

it("全部观察断开后无受理事实仍保持未知且不重投，权威查询恢复后允许后续输入", async () => {
  const h = fixture({ promptTimeoutMs: 30 }); const first = h.request(); await until(() => h.receipts.length === 1);
  first.res.destroy(); await first.task; expect(h.count()).toBe(0);
  const duplicate = h.request(); await duplicate.task;
  expect(h.controller.prompt).toHaveBeenCalledTimes(1); expect(duplicate.res.frames.at(-1)).toMatchObject({ type: "error", code: "OUTCOME_UNKNOWN" });
  const other = h.request("other-client"); await other.task;
  expect(other.res.body).toMatchObject({ code: "OUTCOME_UNKNOWN" });
  h.accept(); h.receipts[0].resolve({ accepted: true });
  const recovered = h.request(undefined, false, "generation?clientMessageId=stable-client"); await recovered.task;
  expect(recovered.res.body.generation).toMatchObject({ clientMessageId: "stable-client", state: "running" });
  const next = h.request("other-client"); await until(() => h.receipts.length === 2); h.accept(1); h.finish("completed", 2); h.receipts[1].resolve({ accepted: true }); await next.task;
  expect(h.controller.prompt).toHaveBeenCalledTimes(2); expect(h.count()).toBe(0);
});

it("无观察时迟到的明确拒绝释放提交记录，同身份可再次进行首次提交", async () => {
  const h = fixture(); const first = h.request(); await until(() => h.receipts.length === 1);
  first.res.destroy(); await first.task; h.receipts[0].resolve({ accepted: false }); await tick();
  const retried = h.request(); await until(() => h.receipts.length === 2); h.accept(1); h.receipts[1].resolve({ accepted: true }); h.finish("completed", 2); await retried.task;
  expect(h.controller.prompt).toHaveBeenCalledTimes(2); expect(h.count()).toBe(0);
});

it("多个观察收到同一错误终态，完成重放不增加原生提交", async () => {
  const h = fixture(); const first = h.request(); await until(() => h.receipts.length === 1); h.accept(); h.receipts[0].resolve({ accepted: true });
  const second = h.request(); await until(() => second.res.frames.length > 0 || second.res.body !== undefined);
  expect(second.res.status).toBe(200); h.finish("error"); await Promise.all([first.task, second.task]);
  for (const result of [first, second]) expect(result.res.frames.at(-1)).toMatchObject({ type: "error", code: "AGENT_FAILED", userMessageId: "native-user-1" });
  const replay = h.request(); await replay.task;
  expect(replay.res.frames.at(-1)).toMatchObject({ type: "error", code: "AGENT_FAILED", messageId: "native-reply-1" });
  expect(h.controller.prompt).toHaveBeenCalledTimes(1); expect(h.count()).toBe(0);
});

it("慢观察溢出只释放自身，其他同身份观察继续增量且新观察仍不重投", async () => {
  const h = fixture({ drainTimeoutMs: 1000, observationTimeoutMs: 2000 }); const slow = h.request("stable-client", true);
  await until(() => h.receipts.length === 1); h.accept(); h.receipts[0].resolve({ accepted: true });
  await until(() => slow.res.frames.length === 1);
  const fast = h.request(); await until(() => fast.res.frames.length > 0 || fast.res.body !== undefined);
  expect(fast.res.status).toBe(200);
  for (let i = 0; i < 135; i++) { h.delta(String(i)); await tick(); }
  await slow.task; expect(slow.res.destroyed).toBe(true);
  expect(fast.res.frames.some((frame) => frame.type === "delta")).toBe(true);
  const third = h.request(); await until(() => third.res.frames.length > 0 || third.res.body !== undefined);
  h.finish(); await Promise.all([fast.task, third.task]);
  expect(h.controller.prompt).toHaveBeenCalledTimes(1); expect(h.count()).toBe(0); expect(slow.res.listenerCount("drain")).toBe(0);
});


it("迟到的持久原生事实优先于旧传输未知回执，重附不重投", async () => {
  const h = fixture(); const first = h.request(); await until(() => h.receipts.length === 1);
  first.res.destroy(); await first.task; h.receipts[0].reject(new Error("合成传输中断")); await tick();
  h.accept(); h.agent.session.snapshotEvents = undefined;
  const reattached = h.request(); await until(() => reattached.res.frames.some((frame) => frame.type === "generation") || reattached.res.writableEnded);
  expect(reattached.res.frames[0]).toMatchObject({ type: "generation", generationId: "dsh:one:message:native-user-1" });
  h.finish(); await reattached.task;
  expect(reattached.res.frames.at(-1)).toMatchObject({ type: "done", userMessageId: "native-user-1" });
  expect(h.controller.prompt).toHaveBeenCalledTimes(1); expect(h.count()).toBe(0);
});


it("同身份观察共享明确拒绝，并在全部释放后允许新输入", async () => {
  const h = fixture(); const first = h.request(); await until(() => h.receipts.length === 1);
  const second = h.request(); await tick(); h.receipts[0].resolve({ accepted: false });
  await Promise.all([first.task, second.task]);
  for (const item of [first, second]) expect(item.res.frames.at(-1)).toMatchObject({ type: "error", code: "AGENT_REJECTED" });
  const next = h.request("other-client"); await until(() => h.receipts.length === 2); h.accept(1); h.receipts[1].resolve({ accepted: true }); h.finish("completed", 2); await next.task;
  expect(h.controller.prompt).toHaveBeenCalledTimes(2); expect(h.count()).toBe(0);
});

it("没有明确受理字段的回执保留未知屏障，不把缺失事实当拒绝后再次入队", async () => {
  const h = fixture(); const first = h.request(); await until(() => h.receipts.length === 1); h.receipts[0].resolve({}); await first.task;
  expect(first.res.frames.at(-1)).toMatchObject({ type: "error", code: "OUTCOME_UNKNOWN" });
  const duplicate = h.request(); await duplicate.task;
  expect(duplicate.res.frames.at(-1)).toMatchObject({ type: "error", code: "OUTCOME_UNKNOWN" });
  expect(h.controller.prompt).toHaveBeenCalledTimes(1); expect(h.count()).toBe(0);
});

it("原生失败但尚无助手消息时只携带已证实的用户和代次身份", async () => {
  const h = fixture(); const first = h.request(); await until(() => h.receipts.length === 1); h.accept(); h.receipts[0].resolve({ accepted: true });
  h.agent.status = "idle";
  h.emit("turn/end", { turn: 1, reason: { kind: "error" } });
  await first.task;
  expect(first.res.frames.at(-1)).toMatchObject({ type: "error", code: "AGENT_FAILED", userMessageId: "native-user-1" });
  expect(first.res.frames.at(-1)).not.toHaveProperty("messageId");
  const replay = h.request(); await replay.task;
  expect(replay.res.frames.at(-1)).toMatchObject({ type: "error", code: "AGENT_FAILED", userMessageId: "native-user-1", generationId: "dsh:one:message:native-user-1" });
  expect(replay.res.frames.at(-1)).not.toHaveProperty("messageId");
  expect(h.controller.prompt).toHaveBeenCalledTimes(1); expect(h.count()).toBe(0);
});


it("已关闭的观察在处理器恢复时不创建提交或宿主监听", async () => {
  const h = fixture();
  // 列表预查先让出一次执行机会，模拟路由解析完成前客户端已经关闭。
  const observer = h.request(); observer.res.destroy(); await observer.task;
  expect(h.controller.prompt).not.toHaveBeenCalled(); expect(h.count()).toBe(0);
});


it("共享迟到传输拒绝不抢占另一观察尚未完成的权威读取", async () => {
  const h = fixture(); const first = h.request(); await until(() => h.receipts.length === 1);
  first.res.destroy(); await first.task;
  const lookup = deferred(); h.services.sessionQuery.readSession = () => lookup.promise;
  const second = h.request(); await tick(); h.receipts[0].reject(new Error("合成迟到传输拒绝")); await tick();
  expect(second.res.writableEnded).toBe(false);
  h.accept(); lookup.resolve({ events: h.events });
  await until(() => second.res.frames.some((frame) => frame.type === "generation"));
  h.finish(); await second.task;
  expect(second.res.frames.at(-1)).toMatchObject({ type: "done", userMessageId: "native-user-1" });
  expect(h.controller.prompt).toHaveBeenCalledTimes(1); expect(h.count()).toBe(0);
});

it("原生用户事实与终态已经写入时，宿主卸载活动Agent后不留下未知提交屏障", async () => {
  const h = fixture(); const first = h.request(); await until(() => h.receipts.length === 1);
  h.accept(); h.finish(); await first.task; h.setLive(undefined);
  const next = h.request("other-client"); await until(() => h.receipts.length === 2 || next.res.writableEnded);
  expect(next.res.body).toBeUndefined(); expect(h.controller.prompt).toHaveBeenCalledTimes(2);
  h.setLive(h.agent); h.accept(1); h.finish("completed", 2); h.receipts[1].resolve({ accepted: true }); await next.task;
  h.receipts[0].resolve({ accepted: true }); await tick(); expect(h.count()).toBe(0);
});


it("首观察在只读预查期间断开时，仍存活观察可原子领取尚未开始的首次提交", async () => {
  const h = fixture(); const initial = deferred(), following = deferred(); let reads = 0;
  h.services.sessionQuery.readSession = () => ++reads === 1 ? initial.promise : following.promise;
  const first = h.request(); await until(() => reads === 1);
  const second = h.request(); await until(() => reads === 2);
  first.res.destroy(); await first.task; expect(h.controller.prompt).not.toHaveBeenCalled();
  following.resolve({ events: [] });
  await until(() => h.receipts.length === 1 || second.res.writableEnded);
  expect(h.controller.prompt).toHaveBeenCalledTimes(1);
  h.accept(); h.receipts[0].resolve({ accepted: true }); h.finish(); await second.task;
  initial.resolve({ events: [] }); await tick();
  expect(second.res.frames.at(-1)).toMatchObject({ type: "done", userMessageId: "native-user-1" });
  expect(h.controller.prompt).toHaveBeenCalledTimes(1); expect(h.count()).toBe(0);
});
