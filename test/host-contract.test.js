import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createSessionHandler } from "../src/index.js";
import { cancelGeneration } from "../src/generation.js";

// 从已安装命令解析真实发行包，CI 未安装 DSH 时明确显示该层未执行。
let hostEntry;
try {
  const command = realpathSync(execFileSync("which", ["dsh"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  hostEntry = createRequire(command).resolve("@deepseek-ai/dsh-api-session-controller");
} catch {}
const hostTest = hostEntry ? it : it.skip;
const token = "test-only-host-contract-token-123456789";

hostTest("真实发行包方法要求受理信号，观察结束后该信号仍有效", async () => {
  const { SessionController } = await import(pathToFileURL(hostEntry).href);
  const listeners = new Map();
  let admissionSignal, nativeSource;
  const session = { id: "host-contract" };
  const emit = (type, data) => {
    for (const listener of listeners.get("session/event") ?? []) listener(session, { type, data });
  };
  const receiver = {
    ctx: { invocation: undefined },
    commands: {
      prompt: async (input, source) => {
        nativeSource = source;
        emit("turn/start", { turn: 1 });
        emit("user/message", { id: "native-input", role: "user", content: input.content, source });
        emit("turn/end", { turn: 1, reason: { kind: "completed" } });
        return { accepted: true };
      },
    },
  };
  const controller = {
    prompt(input, signal) {
      admissionSignal = signal;
      return SessionController.prototype.prompt.call(receiver, input, signal);
    },
  };
  const ctx = {
    get: (name) => ({
      sessionQuery: { listSessions: async () => [{ header: { id: session.id, createdAt: 1000 } }] },
      sessionController: controller,
    })[name],
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return () => listeners.get(name).delete(listener);
    },
  };
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ text: "合成测试", clientMessageId: "host-contract-client" }))]), {
    method: "POST", url: `/oai/session-adapter/v1/sessions/${session.id}/messages`, headers: { authorization: `Bearer ${token}` },
  });
  const response = Object.assign(new EventEmitter(), {
    frames: [],
    writeHead() { this.headersSent = true; },
    write(frame) { this.frames.push(JSON.parse(frame)); return true; },
    end() { this.writableEnded = true; },
  });
  await createSessionHandler(ctx, {}, token)(request, response);
  expect(admissionSignal).toBeInstanceOf(AbortSignal);
  expect(admissionSignal.aborted).toBe(false);
  expect(nativeSource).toMatchObject({ kind: "user", rpcId: "host-contract-client" });
  expect(response.frames.at(-1)).toMatchObject({ type: "done", userMessageId: "native-input" });
  expect([...listeners.values()].every((value) => value.size === 0)).toBe(true);
  await expect(SessionController.prototype.prompt.call(receiver, { content: [{ type: "text", text: "合成测试" }] })).rejects.toBeInstanceOf(TypeError);
  const aborted = new AbortController();
  aborted.abort();
  await expect(SessionController.prototype.prompt.call(receiver, { content: [{ type: "text", text: "合成测试" }] }, aborted.signal)).rejects.toBeDefined();
});

hostTest("原样提取真实发行包取消方法，验证匹配后同步中止且保留待发输入", async () => {
  const requireHost = createRequire(hostEntry);
  const source = readFileSync(requireHost.resolve("@deepseek-ai/dsh-agent-loop"), "utf8");
  const start = source.indexOf("\tcancel(cause, options = {}) {");
  const end = source.indexOf("\n\trunMaintenance(", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // 发行包未导出内部驱动类，此处仅原样提取方法体，明确不冒充完整宿主运行。
  const nativeCancel = new Function(`return ({${source.slice(start, end)}}).cancel;`)();
  const abort = new AbortController();
  let cleared = false, synchronousAbort = false;
  abort.signal.addEventListener("abort", () => { synchronousAbort = true; });
  const events = [
    { seq: 0, type: "turn/start", data: { turn: 4 } },
    { seq: 1, type: "user/message", data: { id: "native-cancel-user", role: "user", source: { kind: "user", rpcId: "cancel-client" } } },
  ];
  const agent = {
    status: "running", phase: { kind: "running", abort },
    inbox: { clear() { cleared = true; } }, session: { snapshotEvents: () => events }, cancel: nativeCancel,
  };
  const result = cancelGeneration("native-cancel", "dsh:native-cancel:message:native-cancel-user", () => agent);
  expect(result).toMatchObject({ requested: true, outcome: "unknown" });
  expect(synchronousAbort).toBe(true);
  expect(abort.signal.reason).toEqual({ kind: "user" });
  expect(cleared).toBe(false);
  await Promise.resolve();
  expect(events).toHaveLength(2);
});
hostTest("真实Session的人类历史保留append来源并排除模型replace副本", async () => {
  const requireHost = createRequire(hostEntry);
  const { Session, isAppendSurfaceEvent, interruptedTurnClosers } = await import(pathToFileURL(requireHost.resolve("@deepseek-ai/dsh-session")).href);
  const session = Session.create("replace-contract");
  session.append("turn/start", { turn: 1 });
  const original = session.append("user/message", { id: "original", role: "user", source: { kind: "user", rpcId: "original-client" }, content: [{ type: "text", text: "人类已见原文" }] }, { surfaceOp: "append" });
  session.append("user/message", { id: "model-copy", role: "user", source: { kind: "user", rpcId: "original-client" }, content: [{ type: "text", text: "模型压缩副本" }] }, { surfaceOp: { op: "replace", startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] });
  expect(session.snapshotEvents().filter(isAppendSurfaceEvent).map((event) => event.data.id)).toEqual(["original"]);
  const events = [...session.snapshotEvents(), ...interruptedTurnClosers(session.snapshotEvents())];
  const { projectGenerations } = await import("../src/generation.js");
  expect(projectGenerations("replace-contract", events).current).toMatchObject({ state: "unknown" });
});

hostTest("官方未进入store的prepare摘要与原readSurface及readTitle逐字段一致", async () => {
  const requireHost = createRequire(hostEntry);
  const { Session, SessionStore } = await import(pathToFileURL(requireHost.resolve("@deepseek-ai/dsh-session")).href);
  const { SessionQueryEngine } = await import(pathToFileURL(requireHost.resolve("@deepseek-ai/dsh-session-query")).href);
  const { foldSessionTitle } = await import(pathToFileURL(requireHost.resolve("@deepseek-ai/dsh-session-title")).href);
  const { currentSessionMessageProjections } = await import(pathToFileURL(requireHost.resolve("@deepseek-ai/dsh-session-format-catalog/message-projections")).href);
  const source = Session.create("native-semantic-summary");
  source.append("turn/start", { turn: 1 });
  const original = source.append("user/message", { id: "original", role: "user", source: { kind: "user", rpcId: "synthetic-original" }, content: [{ type: "text", text: "已替换的合成输入" }] }, { surfaceOp: "append" });
  source.append("user/message", { id: "replacement", role: "user", source: { kind: "user", rpcId: "synthetic-replacement" }, content: [{ type: "text", text: "当前合成表面" }] },
    { surfaceOp: { op: "replace", startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] });
  source.append("session/title", { title: "保留原生标题", messageSeqs: [], source: { kind: "user" } });
  source.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  const events = structuredClone(source.snapshotEvents()).map((event) => ({ ...event,
    time: event.type === "turn/end" ? 15000 : event.type === "session/title" ? 4000 : event.seq === original.seq ? 9000 : 3000 }));
  const header = { ...source.header, createdAt: 1000 };
  const originalSurface = await SessionQueryEngine.prototype.readSurface.call({
    _corpus: { load: async () => ({ header, inheritedEventCount: 0, events }) },
  }, source.id);
  const title = foldSessionTitle(events);
  const expected = { id: source.id, title: title.title,
    updatedAt: new Date(Math.max(header.createdAt, title.updatedAt, ...originalSurface.events.map((event) => event.time))).toISOString(), archived: false };
  let disposed = 0, prepared = 0;
  const store = new Map([[source.id, source]]);
  const query = {
    listSessions: async () => [{ header }], readSurface: async () => { throw new Error("不得回到全库路径"); },
    readTitle: async () => { throw new Error("不得回到全库路径"); },
    observeSession: async () => ({ header, events, inheritedEventCount: 0, [Symbol.dispose]() { disposed++; } }),
  };
  const sessions = { prepare(id, options) {
    prepared++;
    return SessionStore.prototype.prepare.call({ store, projections: currentSessionMessageProjections }, id, options);
  } };
  const ctx = { get: (name) => ({ sessionQuery: query, sessions })[name] };
  const req = Object.assign(Readable.from([]), { method: "GET", url: "/oai/session-adapter/v1/sessions", headers: { authorization: `Bearer ${token}` } });
  const res = Object.assign(new EventEmitter(), {
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    end(body) { this.body = JSON.parse(body); this.writableEnded = true; },
  });
  await createSessionHandler(ctx, {}, token)(req, res);
  expect(res.statusCode).toBe(200);
  expect(res.body.sessions).toEqual([expected]);
  expect(expected.updatedAt).toBe(new Date(4000).toISOString());
  expect(disposed).toBe(1);
  expect(prepared).toBe(1);
  expect([...store.keys()]).toEqual([source.id]);
  expect(source.snapshotEvents()).toHaveLength(events.length);
});

hostTest("继承日志的精确摘要保留原生标题时间且不追加种子事件", async () => {
  const requireHost = createRequire(hostEntry);
  const { Session, SessionStore } = await import(pathToFileURL(requireHost.resolve("@deepseek-ai/dsh-session")).href);
  const { SessionQueryEngine } = await import(pathToFileURL(requireHost.resolve("@deepseek-ai/dsh-session-query")).href);
  const { foldSessionTitle } = await import(pathToFileURL(requireHost.resolve("@deepseek-ai/dsh-session-title")).href);
  const { currentSessionMessageProjections } = await import(pathToFileURL(requireHost.resolve("@deepseek-ai/dsh-session-format-catalog/message-projections")).href);
  const parent = Session.create("summary-parent");
  parent.append("turn/start", { turn: 1 });
  parent.append("user/message", { id: "inherited-input", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "继承的合成输入" }] }, { surfaceOp: "append" });
  parent.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  const inherited = parent.snapshotEvents();
  const source = Session.create("seeded-summary", inherited, { ...parent.header, id: "seeded-summary", isSeeded: true }, inherited.length, currentSessionMessageProjections);
  source.append("session/title", { title: "继承后重命名", messageSeqs: [], source: { kind: "user" } });
  const events = structuredClone(source.snapshotEvents()).map((event) => ({ ...event, time: event.type === "session/title" ? 8000 : 2000 }));
  const header = { ...source.header, createdAt: 1000 }, before = JSON.stringify(events);
  const originalSurface = await SessionQueryEngine.prototype.readSurface.call({ _corpus: {
    load: async () => ({ header, inheritedEventCount: inherited.length, events }),
  } }, source.id);
  const title = foldSessionTitle(events);
  const expected = { id: source.id, title: title.title,
    updatedAt: new Date(Math.max(header.createdAt, title.updatedAt, ...originalSurface.events.map((event) => event.time))).toISOString(), archived: false };
  const store = new Map();
  let released = 0, detachedEvents;
  const query = { listSessions: async () => [{ header }], readSurface() { throw new Error("不得全库预查"); },
    observeSession: async () => ({ header, inheritedEventCount: inherited.length, events, [Symbol.dispose]() { released++; } }) };
  const sessions = { prepare(id, options) {
    const prepared = SessionStore.prototype.prepare.call({ store, projections: currentSessionMessageProjections }, id, options);
    detachedEvents = prepared.snapshotEvents();
    return prepared;
  } };
  const ctx = { get: (name) => ({ sessionQuery: query, sessions })[name] };
  const req = Object.assign(Readable.from([]), { method: "GET", url: "/oai/session-adapter/v1/sessions", headers: { authorization: `Bearer ${token}` } });
  const res = Object.assign(new EventEmitter(), { writeHead(status) { this.statusCode = status; this.headersSent = true; },
    end(body) { this.body = JSON.parse(body); this.writableEnded = true; } });
  await createSessionHandler(ctx, {}, token)(req, res);
  expect(res.statusCode).toBe(200);
  expect(res.body.sessions).toEqual([expected]);
  expect(expected.updatedAt).toBe(new Date(8000).toISOString());
  expect(detachedEvents).toHaveLength(events.length);
  expect(JSON.stringify(events)).toBe(before);
  expect(store.size).toBe(0);
  expect(released).toBe(1);
});
