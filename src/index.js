/** DSH 原生会话适配器；Android 认证与设备操作由 Core 负责。 */
import { createServer } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { diagnosticTrace } from "./diagnostics.js";
import { cancelGeneration, cancellationOutcome, findGeneration, generationIdFor, projectGenerations, publicGeneration } from "./generation.js";

export const name = "oai-session-adapter";
export const inject = ["sessionQuery"];
const PREFIX = "/oai/session-adapter/v1";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_OBSERVER_FRAMES = 128;
const MAX_OBSERVER_BYTES = 1024 * 1024;
const observerDefaults = { promptTimeoutMs: 30_000, observationTimeoutMs: 30 * 60 * 1000, drainTimeoutMs: 5000 };
const methods = ["list", "history", "create", "send", "rename", "archive", "delete", "cancel", "stream"];
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const textOf = (message) => (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
// 当前宿主的用户消息直接存放在 data；助手消息保留轮次包装，兼容旧版用户消息包装。
const messageOf = (event) => event.type === "user/message" ? (event.data?.message ?? event.data) : event.data?.message;
// 官方客户端将这四类来源归为默认折叠的模型上下文，不是用户提交。
const contextSources = new Set(["agent-instructions", "runtime-context", "skill-catalog", "time-context"]);
const iso = (time) => new Date(time).toISOString();
const turnResult = (reason, text, identity = {}) => {
  if (reason === "completed") return { type: "done", text, ...identity };
  const codes = { error: "AGENT_FAILED", aborted: "CANCELLED", blocked: "AGENT_BLOCKED", "max-tokens": "AGENT_MAX_TOKENS", interrupted: "OUTCOME_UNKNOWN" };
  const code = codes[reason] ?? "HOST_INCOMPATIBLE";
  return { type: "error", code, ...identity, ...(["OUTCOME_UNKNOWN", "HOST_INCOMPATIBLE"].includes(code) ? { state: "unknown" } : {}) };
};

// 观察结束后，挂起的受理回执只保留可解除的槽位，不持有响应、文字缓存和监听器。
function releaseSubmission(claims, claim) {
  if (claims.get(claim.id) === claim && claim.observers.size === 0
      && (!claim.recoverable || !claim.submitted || claim.authoritative || claim.result === "rejected")) claims.delete(claim.id);
}

// 未决宿主承诺只保留标量提交身份和可解绑回执槽，不持有 HTTP、正文或监听器。
function observeAdmission(promise, claims, claim) {
  promise.then((receipt) => {
    claim.result = receipt?.accepted === true ? "accepted" : receipt?.accepted === false ? "rejected" : "unknown";
    for (const observer of claim.observers) observer.accept?.(receipt);
    releaseSubmission(claims, claim);
  }, () => {
    claim.result = "unknown";
    for (const observer of claim.observers) observer.fail?.();
    releaseSubmission(claims, claim);
  });
}

function observeLookup(promise, observer) {
  promise.then((value) => observer.resolve?.(value), () => observer.reject?.());
}

export const Config = {
  "~standard": {
    version: 1,
    vendor: "oai-session-adapter",
    validate(input = {}) {
      const value = {
        port: input.port ?? 8791, tokenEnv: input.tokenEnv ?? "OAI_DSH_ADAPTER_TOKEN", cwd: input.cwd, agentPreset: input.agentPreset,
        instanceId: input.instanceId ?? process.env.OAI_DSH_INSTANCE_ID ?? "dsh",
        ...Object.fromEntries(Object.entries(observerDefaults).map(([key, fallback]) => [key, input[key] ?? fallback])),
      };
      if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535
          || typeof value.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.tokenEnv)
          || (value.instanceId !== undefined && (typeof value.instanceId !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/.test(value.instanceId)))
          || (value.cwd !== undefined && typeof value.cwd !== "string")
          || (value.agentPreset !== undefined && typeof value.agentPreset !== "string")
          || Object.keys(observerDefaults).some((key) => !Number.isSafeInteger(value[key]) || value[key] <= 0 || value[key] > 2_147_483_647)) {
        return { issues: [{ message: "Invalid OAI session adapter configuration" }] };
      }
      return { value };
    },
  },
};

async function bodyOf(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size >= MAX_REQUEST_BYTES) {
      // 保留连接返回413，丢弃剩余字节，不再积累同等大小的缓冲。
      req.resume();
      throw fail("PAYLOAD_TOO_LARGE", 413);
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw fail("SCHEMA_INVALID", 400); }
}

/** 查询范围只属于明确安装此插件的 DSH 实例。 */
export function createSessionHandler(ctx, config, token, { heartbeatIntervalMs = 10_000 } = {}) {
  if (typeof token !== "string" || token.length < 32) throw fail("ADAPTER_TOKEN_REQUIRED", 500);
  const expected = Buffer.from(`Bearer ${token}`);
  const validated = Config["~standard"].validate(config);
  if (validated.issues) throw fail("SCHEMA_INVALID", 500);
  const budgets = validated.value;
  const busy = new Map();
  const services = () => ({ query: ctx.get("sessionQuery"), controller: ctx.get("sessionController"), registry: ctx.get("workspaceRegistry"), agents: ctx.get("agents") });
  const capabilities = () => {
    const { query, controller, registry, agents } = services();
    const value = Object.fromEntries(methods.map((method) => [method, false]));
    // 稳定 rpcId 用于关联输入；是否幂等仍须单独验证宿主持久化与去重。
    value.streamHeartbeat = true;
    value.generationRecovery = typeof query?.readSession === "function" && typeof agents?.get === "function";
    value.idempotentSend = false;
    value.list = typeof query?.listSessions === "function";
    value.history = typeof query?.readSurface === "function";
    value.create = value.list && typeof controller?.create === "function";
    value.send = value.list && typeof controller?.prompt === "function" && typeof ctx.on === "function";
    value.stream = value.send;
    value.clientMessageIdentity = value.send;
    value.rename = value.list && typeof controller?.rename === "function";
    // 仅原生完整日志与同步活动句柄都可用时，开放精确轮次取消。
    value.cancel = value.generationRecovery;
    // 宿主查询没有可验证的归档状态，不能声明无法如实回读的管理能力。
    return value;
  };
  const records = async (signal) => {
    if (!capabilities().list) throw fail("HOST_INCOMPATIBLE", 503);
    return await services().query.listSessions(signal);
  };
  // 目录及精确读取只属于观察请求；断开与期限均不取消宿主生成。
  const queryRequest = async (req, res, operation) => {
    if (req.aborted || res.destroyed || res.writableEnded) throw fail("OBSERVER_CLOSED", 499);
    const abort = new AbortController();
    const closed = () => abort.abort(fail("OBSERVER_CLOSED", 499));
    const timer = setTimeout(() => abort.abort(fail("AGENT_QUERY_TIMEOUT", 504)), budgets.promptTimeoutMs);
    req.once("aborted", closed);
    res.once("close", closed);
    let rejectAbort;
    const cancelled = new Promise((_, reject) => { rejectAbort = () => reject(abort.signal.reason); });
    abort.signal.addEventListener("abort", rejectAbort, { once: true });
    try {
      return await Promise.race([operation(abort.signal), cancelled]);
    } finally {
      clearTimeout(timer);
      req.off("aborted", closed);
      res.off("close", closed);
      abort.signal.removeEventListener("abort", rejectAbort);
      abort.abort(fail("OBSERVER_CLOSED", 499));
    }
  };
  // 整个插件共享两个读取槽，多个观察请求也不会放大宿主冷读并发。
  let summaryReaders = 0;
  const summaryWaiters = [];
  const withSummaryReader = async (signal, operation) => {
    signal.throwIfAborted();
    if (summaryReaders >= 2) {
      await new Promise((resolve, reject) => {
        const waiter = { resolve: () => { signal.removeEventListener("abort", cancelled); resolve(); } };
        const cancelled = () => {
          const index = summaryWaiters.indexOf(waiter);
          if (index >= 0) summaryWaiters.splice(index, 1);
          reject(signal.reason);
        };
        summaryWaiters.push(waiter);
        signal.addEventListener("abort", cancelled, { once: true });
      });
    } else summaryReaders++;
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      const next = summaryWaiters.shift();
      if (next) next.resolve();
      else summaryReaders--;
    }
  };
  const requireSession = async (id, signal) => {
    const record = (await records(signal)).find((item) => item.header?.id === id);
    if (!record) throw fail("SESSION_NOT_FOUND", 404);
    return record;
  };
  const generationProjection = async (id) => {
    if (!capabilities().generationRecovery) throw fail("UNSUPPORTED_CAPABILITY");
    const { query, agents } = services();
    const snapshot = await query.readSession(id);
    const agent = agents.get(id);
    const projection = projectGenerations(id, typeof agent?.session?.snapshotEvents === "function" ? agent.session.snapshotEvents() : snapshot.events,
      { liveRunning: agent?.status === "running" });
    const claim = busy.get(id);
    if (claim?.recoverable && findGeneration(projection, { clientMessageId: claim.clientMessageId })) {
      claim.authoritative = true;
      releaseSubmission(busy, claim);
    }
    return projection;
  };
  const liveProjection = (id) => {
    const agent = services().agents?.get(id);
    return typeof agent?.session?.snapshotEvents === "function"
      ? projectGenerations(id, agent.session.snapshotEvents(), { liveRunning: agent.status === "running" }) : undefined;
  };
  const summary = async (record, signal) => withSummaryReader(signal, async () => {
    const { query } = services();
    const sessions = ctx.get("sessions");
    let title, surface;
    if (typeof query.observeSession === "function" && typeof sessions?.prepare === "function") {
      // 官方精确观察不做全库预查；租约仅在此同步摘要折叠期间持有。
      const observation = await query.observeSession(record.header.id, { signal, projectionMode: "none" });
      let prepared;
      try {
        signal.throwIfAborted();
        // prepare 不进入宿主会话表、不发布事件、不写持久层；复用官方 surface 解释器。
        prepared = sessions.prepare(randomUUID(), { seed: observation.events, meta: observation.header,
          inheritedEventCount: observation.inheritedEventCount });
        const titleEvent = observation.events.findLast((event) => event.type === "session/title");
        // 与官方 foldSessionTitle 相同的最新不可变标题字段，不触发逐项全库扫描。
        title = titleEvent === undefined ? undefined : { title: titleEvent.data.title, updatedAt: titleEvent.time };
        surface = { events: prepared.surface.nodes.map((seq) => observation.events[seq]) };
      } finally {
        prepared?.[Symbol.dispose]?.();
        observation[Symbol.dispose]();
      }
    } else {
      // 旧宿主仍保留已存在的摘要能力，读取并发同样有界。
      title = typeof query.readTitle === "function" ? await query.readTitle(record.header.id, signal) : undefined;
      signal.throwIfAborted();
      surface = typeof query.readSurface === "function" ? await query.readSurface(record.header.id) : undefined;
    }
    signal.throwIfAborted();
    let updatedAt = Math.max(record.header.createdAt, title?.updatedAt ?? 0);
    for (const event of surface?.events ?? []) updatedAt = Math.max(updatedAt, event.time);
    return { id: record.header.id, title: title?.title ?? record.header.id, updatedAt: iso(updatedAt), archived: false };
  });
  const summaries = async (signal) => {
    const listed = await records(signal);
    const results = new Array(listed.length);
    const failed = new AbortController();
    const readingSignal = AbortSignal.any([signal, failed.signal]);
    let next = 0, failure;
    const worker = async () => {
      while (next < listed.length && !failure) {
        readingSignal.throwIfAborted();
        const index = next++;
        try { results[index] = await summary(listed[index], readingSignal); }
        catch (error) {
          failure ??= error;
          failed.abort(failure);
          throw error;
        }
      }
    };
    const completed = await Promise.allSettled(Array.from({ length: Math.min(2, listed.length) }, worker));
    if (failure) throw failure;
    const rejected = completed.find((value) => value.status === "rejected");
    if (rejected) throw rejected.reason;
    return results;
  };
  const json = (res, value, status = 200) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };

  async function stream(req, res, id, body) {
    const trace = diagnosticTrace(req.headers);
    trace("adapter.dsh.message_received", { conversationId: id, clientMessageId: body.clientMessageId });
    let firstContent = false;
    if (req.aborted || res.destroyed || res.writableEnded) return;
    if (!capabilities().send) throw fail("UNSUPPORTED_CAPABILITY");
    if (typeof body.text !== "string" || !body.text.trim()
        || (body.clientMessageId !== undefined && (typeof body.clientMessageId !== "string"
          || !/^[A-Za-z0-9._~-]{1,128}$/.test(body.clientMessageId)))) throw fail("SCHEMA_INVALID", 400);
    const requestId = body.clientMessageId ?? randomUUID();
    const recoverable = body.clientMessageId !== undefined && capabilities().generationRecovery;
    let submission = busy.get(id);
    if (submission?.recoverable && submission.observers.size === 0
        && findGeneration(liveProjection(id) ?? { generations: [] }, { clientMessageId: submission.clientMessageId })) {
      submission.authoritative = true;
      releaseSubmission(busy, submission);
      submission = busy.get(id);
    }
    if (submission && !(recoverable && submission.clientMessageId === body.clientMessageId)) {
      throw fail(submission.observers.size ? "SESSION_BUSY" : "OUTCOME_UNKNOWN");
    }
    if (!submission) {
      submission = { id, clientMessageId: body.clientMessageId, recoverable, submitted: false, authoritative: false, observers: new Set() };
      busy.set(id, submission);
    }
    const disposers = [];
    const queue = [];
    const ownAttempts = new Set();
    const admission = {};
    submission.observers.add(admission);
    const lookupObserver = {};
    const identity = {};
    const pendingFrames = [];
    const followAbort = new AbortController();
    let currentTurn, ownTurn, finalText = "", ending = false, stopped = false, admitted = false, generationAnnounced = false, lookupComplete = false;
    let queuedBytes = 0, pendingBytes = 0, pauseFrames = body.clientMessageId !== undefined && capabilities().generationRecovery;
    let followFrames = false, wake, stopDrain, admissionTimer, observationTimer;
    const notify = () => { const resolve = wake; wake = undefined; resolve?.(); };
    const stop = () => {
      stopped = true;
      queue.length = 0;
      queuedBytes = 0;
      notify();
      stopDrain?.();
      lookupObserver.resolve?.(undefined);
      followAbort.abort();
      pendingFrames.length = 0;
    };
    const overflow = () => {
      // 仅结束观察连接，不改宿主收件队列或运行轮次。
      stop();
      res.destroy();
    };
    const enqueue = (value) => {
      if (stopped) return;
      const frame = JSON.stringify(value) + "\n";
      const size = Buffer.byteLength(frame);
      if (queue.length >= MAX_OBSERVER_FRAMES || queuedBytes + size > MAX_OBSERVER_BYTES) return overflow();
      queue.push({ frame, size });
      queuedBytes += size;
      notify();
    };
    const finish = (value) => {
      if (ending || stopped) return;
      ending = true;
      clearTimeout(admissionTimer);
      clearTimeout(observationTimer);
      enqueue(value);
      lookupObserver.resolve?.(undefined);
      followAbort.abort();
    };
    // 用原生用户消息的 rpcId 绑定本次提交，其他终端轮次不能提前完成本次观察。
    const acceptEvent = (session, event) => {
      if (session?.id !== id || ending || stopped) return;
      if (event.type === "turn/start") currentTurn = event.data.turn;
      if (event.type === "user/message" && messageOf(event)?.source?.rpcId === requestId) {
        ownTurn = event.data?.turn ?? currentTurn ?? ownTurn;
        if (ownTurn === undefined) ownTurn = findGeneration(liveProjection(id) ?? { generations: [] }, { clientMessageId: requestId })?.nativeTurn;
        admitted = true;
        // 即使受理回执延迟，原生持久事件仍可证明输入已被接纳。
        clearTimeout(admissionTimer);
        const message = messageOf(event);
        if (typeof message.id === "string" && message.id) identity.userMessageId = message.id;
        if (identity.userMessageId && capabilities().generationRecovery) {
          identity.generationId = generationIdFor(id, identity.userMessageId);
          submission.authoritative = true;
          if (!generationAnnounced) {
            generationAnnounced = true;
            enqueue({ type: "generation", generationId: identity.generationId,
              ...(Number.isSafeInteger(event.seq) && event.seq >= 0 ? { state: "running", revision: event.seq + 1 } : {}),
              ...(body.clientMessageId === undefined ? {} : { clientMessageId: body.clientMessageId }) });
          }
        }
        trace("adapter.dsh.native_user_event", { conversationId: id, clientMessageId: body.clientMessageId,
          userMessageId: identity.userMessageId });
      }
      if (ownTurn === undefined || (event.data.turn !== undefined && event.data.turn !== ownTurn)) return;
      if (event.type === "assistant/message") {
        const message = messageOf(event);
        finalText = textOf(message);
        if (typeof message?.id === "string" && message.id) identity.messageId = message.id;
        else delete identity.messageId;
      }
      if (event.type === "turn/end") {
        const reason = event.data.reason?.kind;
        trace("adapter.dsh.native_terminal", { conversationId: id, clientMessageId: body.clientMessageId,
          messageId: identity.messageId,
          state: ({ completed: "completed", error: "failed", blocked: "failed", "max-tokens": "failed", aborted: "cancelled" })[reason] ?? "unknown" });
        finish(turnResult(reason, finalText, identity));
      }
    };
    disposers.push(ctx.on("session/event", (session, event) => { if (!followFrames) acceptEvent(session, event); }));
    const acceptFrame = (frame) => {
      if (ending || stopped || ownTurn === undefined) return;
      if (frame?.type === "start" && frame.turn === ownTurn) {
        if (ownAttempts.size >= MAX_OBSERVER_FRAMES && !ownAttempts.has(frame.attemptId)) return overflow();
        ownAttempts.add(frame.attemptId);
      }
      if (frame?.type === "chunk" && ownAttempts.has(frame.attemptId)
          && frame.chunk?.type === "text-delta") {
        if (!firstContent) {
          firstContent = true;
          trace("adapter.dsh.first_content_event", { conversationId: id, clientMessageId: body.clientMessageId });
        }
        enqueue({ type: "delta", text: frame.chunk.text });
      }
      if (frame?.type === "end") ownAttempts.delete(frame.attemptId);
    };
    disposers.push(ctx.on("agent/assistant-stream", (payload) => {
      if (ending || stopped || payload?.agent?.session?.id !== id || followFrames) return;
      if (pauseFrames) {
        const size = Buffer.byteLength(JSON.stringify(payload.frame));
        if (pendingFrames.length >= MAX_OBSERVER_FRAMES || pendingBytes + size > MAX_OBSERVER_BYTES) return overflow();
        pendingFrames.push(payload.frame); pendingBytes += size;
      } else acceptFrame(payload.frame);
    }));
    const attachNativeFrames = () => {
      const controller = services().controller;
      pauseFrames = false;
      if (typeof controller.follow !== "function") {
        for (const frame of pendingFrames) acceptFrame(frame);
        pendingFrames.length = 0; pendingBytes = 0;
        return;
      }
      followFrames = true;
      pendingFrames.length = 0; pendingBytes = 0;
      // 官方 follow 的开场快照给出已开始 attempt 及正文前缀，后续帧无缺口。
      (async () => {
        for await (const item of controller.follow({ address: { kind: "session", sessionId: id }, assistantStream: true, maxMessages: 1 }, followAbort.signal)) {
          if (ending || stopped) break;
          if (item.type === "snapshot") {
            // 开场快照可能晚于预查：先同步权威轮次、正文和身份，再恢复活动尝试。
            const latest = findGeneration(liveProjection(id) ?? { generations: [] }, { clientMessageId: requestId });
            if (latest) {
              if (latest.nativeTurn !== undefined) ownTurn = latest.nativeTurn;
              finalText = latest.text;
              if (latest.messageId !== undefined) identity.messageId = latest.messageId;
            }
            const attempt = item.assistantStream?.activeAttempt;
            if (attempt?.turn === ownTurn) ownAttempts.add(attempt.attemptId);
            let prefix = "", bytes = 0;
            for (const record of attempt?.turn === ownTurn ? attempt.stream ?? [] : []) {
              const text = record.type === "text-chunks" ? record.texts.join("")
                : record.type === "chunk" && record.chunk?.type === "text-delta" ? record.chunk.text : "";
              bytes += Buffer.byteLength(text);
              if (bytes > MAX_OBSERVER_BYTES) { overflow(); break; }
              prefix += text;
            }
            if (prefix && !stopped) enqueue({ type: "delta", text: prefix });
            if (latest && ["completed", "failed", "cancelled"].includes(latest.state)) {
              finish(latest.state === "completed" ? { type: "done", text: finalText, ...identity }
                : { type: "error", code: latest.code ?? "AGENT_FAILED", ...identity });
            }
          } else if (item.type === "assistant-stream") acceptFrame(item.frame);
          else if (item.type === "event") acceptEvent({ id }, item.event);
        }
      })().catch(() => { if (!followAbort.signal.aborted) unknown(); });
    };
    const waitForDrain = () => new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        res.off("drain", done);
        stopDrain = undefined;
        resolve();
      };
      const timer = setTimeout(overflow, budgets.drainTimeoutMs);
      stopDrain = done;
      res.once("drain", done);
      if (stopped || res.destroyed) done();
    });
    res.on("close", stop);
    res.on("error", overflow);
    const unknown = () => finish({ type: "error", code: "OUTCOME_UNKNOWN", ...identity, state: "unknown" });
    admissionTimer = setTimeout(unknown, budgets.promptTimeoutMs);
    observationTimer = setTimeout(unknown, budgets.observationTimeoutMs);
    try {
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      // 宿主要求有效的受理信号；该信号独立于观察连接，断线不取消已提交输入。
      const admissionSignal = new AbortController().signal;
      admission.accept = (receipt) => {
        if (stopped || ending || !lookupComplete) return;
        clearTimeout(admissionTimer);
        if (receipt?.accepted !== true && !admitted) {
          if (receipt?.accepted === false || !recoverable) finish({ type: "error", code: "AGENT_REJECTED" });
          else unknown();
        }
      };
      admission.fail = () => {
        // 传输错误不能抢在此观察的权威预查之前决定本轮未知。
        if (lookupComplete && !admitted) unknown();
      };
      let existing = body.clientMessageId !== undefined && capabilities().generationRecovery
        ? await new Promise((resolve) => {
          lookupObserver.resolve = resolve;
          lookupObserver.reject = () => { unknown(); resolve(undefined); };
          observeLookup(generationProjection(id).then((projection) => findGeneration(projection, { clientMessageId: body.clientMessageId })), lookupObserver);
        }) : null;
      lookupObserver.resolve = lookupObserver.reject = undefined;
      lookupComplete = true;
      if (existing) existing = findGeneration(liveProjection(id) ?? { generations: [existing] }, { clientMessageId: body.clientMessageId }) ?? existing;
      if (existing) {
        admitted = true;
        submission.authoritative = true;
        ownTurn = existing.nativeTurn;
        identity.generationId = existing.generationId;
        identity.userMessageId = existing.userMessageId;
        if (existing.messageId !== undefined) identity.messageId = existing.messageId;
        finalText = existing.text;
        clearTimeout(admissionTimer);
        if (!generationAnnounced) {
          generationAnnounced = true;
          enqueue({ type: "generation", generationId: existing.generationId,
            ...(["queued", "running", "unknown"].includes(existing.state) ? { state: existing.state, revision: existing.revision } : {}),
            clientMessageId: body.clientMessageId });
        }
        if (existing.state === "completed") finish({ type: "done", text: finalText, ...identity });
        else if (["failed", "cancelled"].includes(existing.state)) finish({ type: "error", code: existing.code ?? "AGENT_FAILED", ...identity });
        else if (existing.state === "unknown") unknown();
        else attachNativeFrames();
      } else if (!ending && !stopped) {
        if (submission.result === "accepted") admission.accept({ accepted: true });
        else if (submission.result === "rejected") admission.accept({ accepted: false });
        else if (submission.result === "unknown") admission.fail();
        pauseFrames = false;
        for (const frame of pendingFrames) acceptFrame(frame);
        pendingFrames.length = 0; pendingBytes = 0;
        // 只读预查后同步领取尚未开始的提交；首观察离开可交接，已提交则永不重投。
        if (!submission.submitted && !ending && !stopped) {
          submission.submitted = true;
          trace("adapter.dsh.host_submitted", { conversationId: id, clientMessageId: body.clientMessageId });
          observeAdmission(Promise.resolve().then(() => services().controller.prompt({
            requestId, sessionId: id, mode: "queue", content: [{ type: "text", text: body.text }],
          }, admissionSignal)), busy, submission);
        }
      }
      while (!stopped) {
        if (!queue.length) {
          if (ending) break;
          let timer;
          await new Promise((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, heartbeatIntervalMs);
          });
          clearTimeout(timer);
          wake = undefined;
          if (!stopped && !ending && !queue.length && !res.write("\n")) await waitForDrain();
          continue;
        }
        const { frame, size } = queue.shift();
        queuedBytes -= size;
        if (!res.write(frame)) await waitForDrain();
      }
      if (!res.destroyed && !res.writableEnded) res.end();
    } finally {
      trace("adapter.dsh.observer_closed", { conversationId: id, clientMessageId: body.clientMessageId });
      stop();
      clearTimeout(admissionTimer);
      clearTimeout(observationTimer);
      res.off("close", stop);
      res.off("error", overflow);
      admission.accept = admission.fail = undefined;
      lookupObserver.resolve = lookupObserver.reject = undefined;
      for (const dispose of disposers) dispose();
      ownAttempts.clear();
      submission.observers.delete(admission);
      releaseSubmission(busy, submission);
    }
  }

  return async (req, res) => {
    try {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail("AUTHENTICATION_REQUIRED", 401);
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      if (url.search && !path.endsWith("/generation")) throw fail("SCHEMA_INVALID", 400);
      if (req.method === "POST" && path === PREFIX + "/handshake") {
        const body = await bodyOf(req);
        if (!budgets.instanceId || Object.keys(body).length !== 1 || typeof body.challenge !== "string"
            || !/^[a-f0-9]{64}$/.test(body.challenge)) throw fail("SCHEMA_INVALID", 400);
        const declared = capabilities();
        // 与状态接口一样核验真实宿主查询，不能凭函数存在就声明在线。
        await queryRequest(req, res, records);
        const online = declared.list && declared.history;
        const sorted = Object.fromEntries(Object.entries(declared).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        const payload = { capabilities: sorted, challenge: body.challenge, instanceId: budgets.instanceId,
          online, sessionScope: "deployment" };
        const proof = createHmac("sha256", token).update("oai-agent-handshake-v1\0").update(JSON.stringify(payload)).digest("hex");
        return json(res, { instanceId: budgets.instanceId, sessionScope: "deployment", online, capabilities: declared, proof });
      }
      if (req.method === "GET" && path === PREFIX + "/status") {
        const caps = capabilities();
        // 执行真实查询，持久层失败时不能仅凭插件已加载就声明在线。
        await queryRequest(req, res, records);
        return json(res, { online: caps.list && caps.history, capabilities: caps });
      }
      if (path === PREFIX + "/sessions") {
        if (req.method === "GET") return json(res, { sessions: await queryRequest(req, res, summaries) });
        if (req.method === "POST") {
          if (!capabilities().create) throw fail("UNSUPPORTED_CAPABILITY");
          const body = await bodyOf(req);
          if (Object.keys(body).some((key) => key !== "title")) throw fail("SCHEMA_INVALID", 400);
          if (body.title != null && (typeof body.title !== "string" || !body.title.trim())) throw fail("SCHEMA_INVALID", 400);
          if (body.title && !capabilities().rename) throw fail("UNSUPPORTED_CAPABILITY");
          const trace = diagnosticTrace(req.headers);
          trace("adapter.dsh.create_submitted");
          const created = await services().controller.create({ sessionId: randomUUID(), cwd: config.cwd, agentPreset: config.agentPreset });
          trace("adapter.dsh.create_returned", { conversationId: created.sessionId });
          if (body.title) await services().controller.rename({ sessionId: created.sessionId, title: body.title });
          return json(res, { session: await queryRequest(req, res, async (signal) => summary(await requireSession(created.sessionId, signal), signal)) });
        }
      }
      const match = new RegExp(`^${PREFIX}/sessions/([^/]+)/(history|generation|messages|rename|archive|delete|cancel)$`).exec(path);
      if (!match) throw fail("NOT_FOUND", 404);
      let id;
      try { id = decodeURIComponent(match[1]); } catch { throw fail("SCHEMA_INVALID", 400); }
      const action = match[2];
      await requireSession(id);
      if (req.method === "GET" && action === "generation") {
        const query = url.searchParams;
        const allowed = ["clientMessageId", "generationId", "afterRevision", "waitMs"];
        if ([...query.keys()].some((key) => !allowed.includes(key) || query.getAll(key).length !== 1)) throw fail("INVALID_GENERATION_QUERY", 400);
        const clientMessageId = query.get("clientMessageId") ?? undefined;
        const generationId = query.get("generationId") ?? undefined;
        const specific = clientMessageId !== undefined || generationId !== undefined;
        if ((clientMessageId !== undefined && !/^[A-Za-z0-9._~-]{1,128}$/.test(clientMessageId))
            || (generationId !== undefined && (!generationId || generationId.length > 1024))) throw fail("INVALID_GENERATION_QUERY", 400);
        for (const key of ["afterRevision", "waitMs"]) if (query.has(key)
            && (!specific || !/^(0|[1-9][0-9]*)$/.test(query.get(key)) || !Number.isSafeInteger(Number(query.get(key)))
              || (key === "waitMs" && Number(query.get(key)) > 25_000))) throw fail("INVALID_GENERATION_QUERY", 400);
        const waitMs = Number(query.get("waitMs") ?? 0);
        if (waitMs && !query.has("afterRevision")) throw fail("INVALID_GENERATION_QUERY", 400);
        let projection = await generationProjection(id);
        if (waitMs && projection.revision <= Number(query.get("afterRevision"))) {
          await new Promise((resolve, reject) => {
            let timer, dispose, done = false;
            const finish = () => { if (done) return; done = true; clearTimeout(timer); dispose?.(); res.off("close", finish); resolve(); };
            dispose = ctx.on("session/event", (session) => { if (session?.id === id) finish(); });
            timer = setTimeout(finish, waitMs);
            res.once("close", finish);
            // 订阅后重新读取，补上首次快照与注册监听之间发生的原生事件。
            generationProjection(id).then((latest) => { if (latest.revision > Number(query.get("afterRevision"))) finish(); }, (error) => {
              if (done) return;
              done = true; clearTimeout(timer); dispose?.(); res.off("close", finish); reject(error);
            });
          });
          projection = await generationProjection(id);
        }
        return json(res, { generation: publicGeneration(findGeneration(projection, { clientMessageId, generationId })) });
      }
      if (req.method === "GET" && action === "history") {
        if (!capabilities().history) throw fail("UNSUPPORTED_CAPABILITY");
        const { query, agents } = services();
        const raw = typeof query.readSession === "function";
        const snapshot = await query[raw ? "readSession" : "readSurface"](id);
        const projection = raw ? projectGenerations(id, snapshot.events, { liveRunning: agents?.get(id)?.status === "running" }) : undefined;
        const byUser = new Map(), byReply = new Map();
        for (const receipt of projection?.generations ?? []) {
          byUser.set(receipt.userMessageId, receipt);
          // 同轮次多个输入共用回复时，以最先被原生日志接纳的输入作为回复锚点。
          if (receipt.messageId !== undefined && !byReply.has(receipt.messageId)) byReply.set(receipt.messageId, receipt);
        }
        // 官方人类会话记录只包含 append 来源，模型专用 replace 副本不进入界面。
        const messages = snapshot.events.filter((event) => ["user/message", "assistant/message"].includes(event.type)
          && (event.surfaceOp === undefined || event.surfaceOp === "append")
          && (event.type !== "user/message" || !contextSources.has(messageOf(event)?.source?.kind)))
          .map((event) => {
            const message = messageOf(event);
            if (typeof message?.id !== "string" || !["user", "assistant"].includes(message.role) || !Array.isArray(message.content)) throw fail("HOST_INCOMPATIBLE", 502);
            const clientMessageId = message.role === "user" && typeof message.source?.rpcId === "string"
              && /^[A-Za-z0-9._~-]{1,128}$/.test(message.source.rpcId) ? message.source.rpcId : undefined;
            const receipt = (message.role === "user" ? byUser : byReply).get(message.id);
            return { id: message.id, role: message.role, text: textOf(message), createdAt: iso(event.time),
              ...(clientMessageId === undefined ? {} : { clientMessageId }),
              ...(receipt === undefined ? {} : { generationId: receipt.generationId, state: receipt.state, contentRevision: receipt.revision,
                ...(message.role === "assistant" && receipt.clientMessageId !== undefined ? { clientMessageId: receipt.clientMessageId } : {}) }) };
          });
        return json(res, { messages });
      }
      if (req.method !== "POST") throw fail("NOT_FOUND", 404);
      const body = await bodyOf(req);
      if (action === "messages") {
        if (Object.keys(body).some((key) => !["text", "clientMessageId"].includes(key))) throw fail("SCHEMA_INVALID", 400);
        return await stream(req, res, id, body);
      }
      if (Object.keys(body).some((key) => key !== "value")) throw fail("SCHEMA_INVALID", 400);
      if (!capabilities()[action]) throw fail("UNSUPPORTED_CAPABILITY");
      if (action === "cancel") {
        const value = body.value ?? undefined;
        if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)
            || Object.keys(value).length !== 1 || typeof value.generationId !== "string" || !value.generationId || value.generationId.length > 1024)) throw fail("SCHEMA_INVALID", 400);
        const projection = await generationProjection(id);
        const generation = findGeneration(projection, { generationId: value?.generationId });
        if (!generation) throw fail(value?.generationId ? "GENERATION_NOT_FOUND" : "NO_ACTIVE_TURN", value?.generationId ? 404 : 409);
        const outcome = cancellationOutcome(generation);
        if (outcome !== "unknown") return json(res, { id, action, generationId: generation.generationId, outcome });
        const result = await new Promise((resolve) => {
          let timer, dispose, settled = false;
          const base = { id, action, generationId: generation.generationId, outcome: "outcome_unknown" };
          const finish = (receipt) => { if (settled) return; settled = true; clearTimeout(timer); dispose?.(); resolve(receipt); };
          const check = () => {
            const current = findGeneration(liveProjection(id) ?? { generations: [] }, { generationId: generation.generationId });
            const terminal = cancellationOutcome(current);
            if (terminal !== "unknown") finish({ ...base, outcome: terminal });
          };
          // 先订阅，再同步比较和取消，随后重读；终态等待不拥有其他任务的取消权。
          dispose = ctx.on("session/event", (session) => { if (session?.id === id) check(); });
          timer = setTimeout(() => finish(base), Math.min(budgets.promptTimeoutMs, 5000));
          const { requested, ...receipt } = cancelGeneration(id, generation.generationId, (sessionId) => services().agents.get(sessionId));
          if (receipt.outcome !== "unknown") finish(receipt);
          else if (!requested) finish(base);
          else check();
        });
        return json(res, result);
      }
      const { controller, registry } = services();
      if (action === "rename") {
        if (typeof body.value !== "string" || !body.value.trim()) throw fail("SCHEMA_INVALID", 400);
        await controller.rename({ sessionId: id, title: body.value });
      } else if (action === "archive") {
        if (typeof body.value !== "boolean") throw fail("SCHEMA_INVALID", 400);
        await registry[body.value ? "archiveSession" : "unarchiveSession"](id);

      }
      return json(res, { id, action, ...(action === "archive" ? { archived: body.value } : {}) });
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) json(res, { code: error.code ?? "AGENT_UNAVAILABLE" }, error.status ?? 503);
      else if (!res.writableEnded) res.end();
    }
  };
}

export function apply(ctx, config) {
  const token = process.env[config.tokenEnv];
  if (!token) {
    ctx.logger?.warn?.("OAI 会话适配器未启用：环境变量 %s 未配置（至少32个字符）", config.tokenEnv);
    return;
  }
  const handler = createSessionHandler(ctx, config, token);
  ctx.effect(() => {
    const server = createServer(handler);
    server.listen(config.port, "127.0.0.1");
    server.on("error", (error) => ctx.logger?.error?.("OAI session adapter listener failed: %s", error.code));
    return () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }, "oai-native-session-adapter");
}
