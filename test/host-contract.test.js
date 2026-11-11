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
