import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { createSessionHandler } from "../src/index.js";

const token = "synthetic-corpus-test-token-123456789012345";
const request = (path = "sessions") => Object.assign(Readable.from([]), {
  method: "GET", url: `/oai/session-adapter/v1/${path}`, headers: { authorization: `Bearer ${token}` },
});
const response = () => Object.assign(new EventEmitter(), {
  writeHead(status) { this.statusCode = status; this.headersSent = true; },
  end(body) { this.body = JSON.parse(body); this.writableEnded = true; },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(count = 9) {
  const state = { listings: 0, legacyReads: 0, observations: 0, disposed: 0, active: 0, maximum: 0, prepares: 0, signals: [] };
  const records = Array.from({ length: count }, (_, index) => ({ header: { id: `native-${index}`, createdAt: 1000 }, live: false, persisted: true }));
  const events = [
    { seq: 0, type: "user/message", time: 9000, surfaceOp: "append", data: { id: "original" } },
    { seq: 1, type: "user/message", time: 3000, surfaceOp: { op: "replace", startSeq: 0, endSeq: 0 }, data: { id: "replacement" } },
    { seq: 2, type: "session/title", time: 4000, data: { title: "最新原生标题" } },
    { seq: 3, type: "turn/end", time: 15000, data: {} },
  ];
  const query = {
    async listSessions(signal) { state.listings++; if (signal) state.signals.push(signal); signal?.throwIfAborted(); return records; },
    async readTitle() { state.legacyReads++; state.listings++; return { title: "最新原生标题", updatedAt: 4000 }; },
    async readSurface() { state.legacyReads++; state.listings++; return { events: [events[1]] }; },
    async observeSession(id, options) {
      state.observations++; state.signals.push(options.signal); state.active++; state.maximum = Math.max(state.maximum, state.active);
      expect(options.projectionMode).toBe("none");
      await tick();
      return { header: { id, createdAt: 1000 }, inheritedEventCount: 0, events,
        [Symbol.dispose]() { state.disposed++; state.active--; } };
    },
  };
  const sessions = {
    prepare(id, options) {
      state.prepares++; expect(id).not.toMatch(/^native-/); expect(options.seed).toBe(events);
      return { surface: { nodes: [1] } };
    },
  };
  const ctx = { get: (name) => ({ sessionQuery: query, sessions })[name] };
  return { state, query, ctx, records, events };
}

it("完整列表只扫描一次目录，并有界观察、释放所有租约且保留原surface更新时间", async () => {
  const { state, ctx } = fixture();
  const res = response();
  await createSessionHandler(ctx, {}, token)(request(), res);
  expect(res.statusCode).toBe(200);
  expect(res.body.sessions).toHaveLength(9);
  expect(res.body.sessions[0]).toEqual({ id: "native-0", title: "最新原生标题", updatedAt: new Date(4000).toISOString(), archived: false });
  expect(state.listings).toBe(1);
  expect(state.legacyReads).toBe(0);
  expect(state.observations).toBe(9);
  expect(state.maximum).toBeLessThanOrEqual(2);
  expect(state.disposed).toBe(9);
  expect(state.active).toBe(0);
  expect(state.signals).toHaveLength(10);
  expect(state.signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
});

it("观察关闭时中止挂起读取，不继续领取后续会话或保留响应监听", async () => {
  const { state, query, ctx } = fixture(20);
  query.observeSession = async (_id, { signal }) => {
    state.observations++; state.signals.push(signal);
    await new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const req = request(), res = response();
  const work = createSessionHandler(ctx, {}, token)(req, res);
  await tick(); res.destroyed = true; res.emit("close");
  await Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error("查询未释放")), 250))]);
  expect(state.observations).toBe(2);
  expect(state.signals.every((signal) => signal.aborted)).toBe(true);
  expect(res.listenerCount("close")).toBe(0);
  expect(req.listenerCount("aborted")).toBe(0);
});

it("目录查询超过受理期限时传递取消并返回明确超时", async () => {
  const { query, ctx, state } = fixture();
  query.listSessions = async (signal) => {
    state.signals.push(signal);
    return new Promise((resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const res = response();
  await Promise.race([createSessionHandler(ctx, { promptTimeoutMs: 15 }, token)(request("status"), res),
    new Promise((_, reject) => setTimeout(() => reject(new Error("健康查询未超时")), 250))]);
  expect(res.statusCode).toBe(504);
  expect(res.body.code).toBe("AGENT_QUERY_TIMEOUT");
  expect(state.signals[0].aborted).toBe(true);
});

it("多个列表请求也共享读取上限，取消排队请求后后续列表不受影响", async () => {
  const { state, query, ctx } = fixture(7);
  const original = query.observeSession;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  query.observeSession = async (...args) => {
    entered(); await blocked; return original(...args);
  };
  const handler = createSessionHandler(ctx, {}, token);
  const first = response(), second = response();
  const a = handler(request(), first);
  await started;
  const b = handler(request(), second);
  await tick(); second.destroyed = true; second.emit("close");
  release();
  await Promise.all([a, b]);
  expect(first.body.sessions).toHaveLength(7);
  const third = response();
  await handler(request(), third);
  expect(third.body.sessions).toHaveLength(7);
  expect(state.maximum).toBeLessThanOrEqual(2);
  expect(state.disposed).toBe(state.observations);
  expect(state.active).toBe(0);
});

it("官方表面投影失败时不丢掉会话，释放租约并返回真实失败", async () => {
  const { state, ctx } = fixture(5);
  const get = ctx.get;
  ctx.get = (name) => name === "sessions" ? { prepare() { throw new Error("合成坏日志"); } } : get(name);
  const res = response();
  await createSessionHandler(ctx, {}, token)(request(), res);
  expect(res.statusCode).toBe(503);
  expect(res.body.code).toBe("AGENT_UNAVAILABLE");
  expect(state.observations).toBeLessThanOrEqual(2);
  expect(state.disposed).toBe(state.observations);
  expect(state.active).toBe(0);
});

it("旧宿主保留标题和表面时间读取，同时保持有界并发", async () => {
  const { state, query, ctx } = fixture(5);
  delete query.observeSession;
  const res = response();
  await createSessionHandler(ctx, {}, token)(request(), res);
  expect(res.statusCode).toBe(200);
  expect(res.body.sessions).toHaveLength(5);
  expect(res.body.sessions[0]).toEqual({ id: "native-0", title: "最新原生标题", updatedAt: new Date(4000).toISOString(), archived: false });
  expect(state.legacyReads).toBe(10);
  expect(state.observations).toBe(0);
});

it("请求在进入查询前已断开时不启动宿主读取", async () => {
  const { state, ctx } = fixture();
  const req = request(), res = response();
  req.aborted = true; res.destroyed = true;
  await createSessionHandler(ctx, {}, token)(req, res);
  expect(state.listings).toBe(0);
  expect(state.observations).toBe(0);
  expect(res.listenerCount("close")).toBe(0);
});

it("一条摘要读取失败时立即中止同批挂起观察，保留原始错误且恢复读取槽", async () => {
  const { state, query, ctx } = fixture(6);
  const original = query.observeSession;
  query.observeSession = async (id, options) => {
    if (id === "native-0") { await tick(); throw Object.assign(new Error("合成读取失败"), { code: "SYNTHETIC_READ_FAILURE", status: 502 }); }
    if (id === "native-1") {
      state.signals.push(options.signal);
      await new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    }
    return original(id, options);
  };
  const handler = createSessionHandler(ctx, {}, token);
  const res = response();
  await Promise.race([handler(request(), res), new Promise((_, reject) => setTimeout(() => reject(new Error("同批查询未中止")), 250))]);
  expect(res.statusCode).toBe(502);
  expect(res.body.code).toBe("SYNTHETIC_READ_FAILURE");
  expect(state.signals.every((signal) => signal.aborted)).toBe(true);
  query.observeSession = original;
  const recovered = response();
  await handler(request(), recovered);
  expect(recovered.body.sessions).toHaveLength(6);
  expect(state.active).toBe(0);
});
