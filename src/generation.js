const clientIdentity = /^[A-Za-z0-9._~-]{1,128}$/;
const textOf = (message) => (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
const messageOf = (event) => event.type === "user/message" ? (event.data?.message ?? event.data) : event.data?.message;
const incompatible = () => Object.assign(new Error("HOST_INCOMPATIBLE"), { code: "HOST_INCOMPATIBLE", status: 502 });
const terminalState = (kind) => ({ completed: "completed", error: "failed", blocked: "failed", "max-tokens": "failed", aborted: "cancelled" })[kind] ?? "unknown";
const terminalCode = (kind) => ({ error: "AGENT_FAILED", blocked: "AGENT_BLOCKED", "max-tokens": "AGENT_MAX_TOKENS", aborted: "CANCELLED", interrupted: "OUTCOME_UNKNOWN" })[kind];

export const generationIdFor = (sessionId, messageId) => `dsh:${encodeURIComponent(sessionId)}:message:${encodeURIComponent(messageId)}`;

/** 仅从宿主原生日志恢复事实；连接与适配器内存不拥有执行状态。 */
export function projectGenerations(sessionId, events, { liveRunning = false } = {}) {
  if (!Array.isArray(events)) throw incompatible();
  const messages = new Map();
  const turns = new Map();
  const inbox = { "next-turn": [], "next-step": [] };
  let activeTurn, revision = 0;
  const remember = (message) => {
    if (typeof message?.id !== "string" || !message.id || message.role !== "user") throw incompatible();
    let record = messages.get(message.id);
    if (!record) {
      const rpcId = message.source?.rpcId;
      record = { userMessageId: message.id, ...(typeof rpcId === "string" && clientIdentity.test(rpcId) ? { clientMessageId: rpcId } : {}) };
      messages.set(message.id, record);
    } else if (typeof message.source?.rpcId === "string" && clientIdentity.test(message.source.rpcId)) {
      if (record.clientMessageId !== undefined && record.clientMessageId !== message.source.rpcId) throw incompatible();
      record.clientMessageId = message.source.rpcId;
    }
    return record;
  };
  const turnFor = (turn) => {
    if (!Number.isSafeInteger(turn) || turn < 0) throw incompatible();
    if (!turns.has(turn)) turns.set(turn, { turn, text: "" });
    return turns.get(turn);
  };
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const seq = event.seq ?? index;
    if (!Number.isSafeInteger(seq) || seq < 0) throw incompatible();
    revision = Math.max(revision, seq + 1);
    if (event.type === "turn/start") {
      activeTurn = event.data.turn;
      turnFor(activeTurn);
    } else if (event.type === "turn/end") {
      turnFor(event.data.turn).reason = event.data.reason?.kind ?? "unknown";
      if (event.data.turn === activeTurn) activeTurn = undefined;
    } else if (event.type === "agent/inbox/spliced") {
      const splice = event.data;
      const queue = inbox[splice.target];
      const count = splice.removedCount ?? 0;
      if (!queue || !Array.isArray(splice.inserted) || !Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > queue.length
          || !Number.isSafeInteger(count) || count < 0 || splice.start + count > queue.length) throw incompatible();
      for (const message of splice.inserted) remember(message);
      const removed = queue.slice(splice.start, splice.start + count);
      inbox[splice.target] = [...queue.slice(0, splice.start), ...splice.inserted.map((message) => message.id), ...queue.slice(splice.start + count)];
      for (const id of removed) {
        const record = messages.get(id);
        if (splice.outcome === "canceled") record.cancelled = true;
        else if (activeTurn !== undefined) record.nativeTurn = activeTurn;
      }
    } else if (event.type === "user/message" && (event.surfaceOp === undefined || event.surfaceOp === "append")) {
      const record = remember(messageOf(event));
      const turn = event.data?.turn ?? activeTurn;
      if (turn !== undefined) { turnFor(turn); record.nativeTurn = turn; }
    } else if (event.type === "assistant/message" && (event.surfaceOp === undefined || event.surfaceOp === "append")) {
      const turn = event.data?.turn ?? activeTurn;
      if (turn !== undefined) {
        const result = turnFor(turn);
        const message = messageOf(event);
        result.text = textOf(message);
        if (typeof message?.id === "string" && message.id) result.messageId = message.id;
      }
    }
  }
  const pending = new Set([...inbox["next-step"], ...inbox["next-turn"]]);
  const generations = [...messages.values()].map((record) => {
    const turn = turns.get(record.nativeTurn);
    const state = record.cancelled ? "cancelled" : turn?.reason !== undefined ? terminalState(turn.reason)
      : pending.has(record.userMessageId) ? "queued" : record.nativeTurn !== undefined && record.nativeTurn === activeTurn && liveRunning ? "running" : "unknown";
    const code = record.cancelled ? "CANCELLED" : turn?.reason === undefined ? undefined : terminalCode(turn.reason);
    return {
      generationId: generationIdFor(sessionId, record.userMessageId), conversationId: sessionId, state, revision,
      userMessageId: record.userMessageId, ...(record.clientMessageId === undefined ? {} : { clientMessageId: record.clientMessageId }),
      text: turn?.text ?? "", ...(turn?.messageId === undefined ? {} : { messageId: turn.messageId }),
      ...(code === undefined ? {} : { code }), ...(record.nativeTurn === undefined ? {} : { nativeTurn: record.nativeTurn }),
    };
  });
  let current = activeTurn === undefined ? undefined : generations.find((item) => item.nativeTurn === activeTurn);
  if (activeTurn !== undefined && !current) {
    current = { generationId: `dsh:${encodeURIComponent(sessionId)}:turn:${activeTurn}`, conversationId: sessionId,
      state: liveRunning ? "running" : "unknown", revision, text: "", nativeTurn: activeTurn };
    generations.push(current);
  }
  current ??= generations.find((item) => item.state === "unknown");
  current ??= generations.find((item) => item.state === "queued");
  return { revision, current: current ?? null, generations, activeTurn };
}

/** 同时提供两种身份时必须命中同一条原生受理记录。 */
export function findGeneration(projection, { clientMessageId, generationId } = {}) {
  if (clientMessageId === undefined && generationId === undefined) return projection.current;
  const matches = projection.generations.filter((item) => (clientMessageId === undefined || item.clientMessageId === clientMessageId)
    && (generationId === undefined || item.generationId === generationId));
  if (matches.length > 1) throw incompatible();
  return matches[0] ?? null;
}

export function publicGeneration(generation) {
  if (!generation) return null;
  const { nativeTurn, ...receipt } = generation;
  return receipt;
}

export function cancellationOutcome(generation) {
  return generation?.state === "cancelled" ? "cancelled" : ["completed", "failed"].includes(generation?.state) ? "already_completed" : "unknown";
}

/** 比较权威活动轮次与取消副作用处于同一同步调用栈，中间没有异步交接。 */
export function cancelGeneration(sessionId, generationId, getAgent) {
  const base = { id: sessionId, action: "cancel", ...(generationId === undefined ? {} : { generationId }), outcome: "unknown" };
  if (typeof generationId !== "string" || !generationId) return base;
  const agent = getAgent(sessionId);
  if (!agent || typeof agent.session?.snapshotEvents !== "function") return base;
  const projection = projectGenerations(sessionId, agent.session.snapshotEvents(), { liveRunning: agent.status === "running" });
  const generation = findGeneration(projection, { generationId });
  if (!generation) return base;
  base.generationId = generation.generationId;
  base.outcome = cancellationOutcome(generation);
  if (base.outcome !== "unknown" || generation.nativeTurn === undefined || generation.nativeTurn !== projection.activeTurn
      || agent.status !== "running" || typeof agent.cancel !== "function" || getAgent(sessionId) !== agent) return base;
  agent.cancel({ kind: "user" }, { keepInbox: true });
  const after = projectGenerations(sessionId, agent.session.snapshotEvents(), { liveRunning: agent.status === "running" });
  base.outcome = cancellationOutcome(findGeneration(after, { generationId: generation.generationId }));
  return { ...base, requested: true };
}
