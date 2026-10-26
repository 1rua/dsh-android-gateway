/** DSH native session adapter. Android auth and all device work stay in Core. */
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

export const name = "oai-session-adapter";
export const inject = ["sessionQuery"];
const PREFIX = "/oai/session-adapter/v1";
const MAX_REQUEST_BYTES = 1024 * 1024;
const methods = ["list", "history", "create", "send", "rename", "archive", "delete", "cancel", "stream"];
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const textOf = (message) => (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
// Current DSH logs store a user/message's UserMessage directly in data;
// assistant/message keeps its turn/step wrapper. Older hosts wrapped both.
const messageOf = (event) => event.type === "user/message" ? (event.data?.message ?? event.data) : event.data?.message;
const iso = (time) => new Date(time).toISOString();
const turnResult = (reason, text) => {
  if (reason === "completed") return { type: "done", text };
  const codes = { error: "AGENT_FAILED", aborted: "CANCELLED", blocked: "AGENT_BLOCKED", "max-tokens": "AGENT_MAX_TOKENS", interrupted: "OUTCOME_UNKNOWN" };
  return { type: "error", code: codes[reason] ?? "HOST_INCOMPATIBLE" };
};

export const Config = {
  "~standard": {
    version: 1,
    vendor: "oai-session-adapter",
    validate(input = {}) {
      const value = { port: input.port ?? 8791, tokenEnv: input.tokenEnv ?? "OAI_DSH_ADAPTER_TOKEN", cwd: input.cwd, agentPreset: input.agentPreset };
      if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535
          || typeof value.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.tokenEnv)
          || (value.cwd !== undefined && typeof value.cwd !== "string")
          || (value.agentPreset !== undefined && typeof value.agentPreset !== "string")) {
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
      // Keep the socket available long enough to deliver the 413. Discard
      // remaining bytes without retaining another request-sized buffer.
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

/** The injected query's corpus is the explicitly installed DSH instance only. */
export function createSessionHandler(ctx, config, token) {
  if (typeof token !== "string" || token.length < 32) throw fail("ADAPTER_TOKEN_REQUIRED", 500);
  const expected = Buffer.from(`Bearer ${token}`);
  const busy = new Set();
  const services = () => ({ query: ctx.get("sessionQuery"), controller: ctx.get("sessionController"), registry: ctx.get("workspaceRegistry") });
  const capabilities = () => {
    const { query, controller, registry } = services();
    const value = Object.fromEntries(methods.map((method) => [method, false]));
    value.list = typeof query?.listSessions === "function";
    value.history = typeof query?.readSurface === "function";
    value.create = value.list && typeof controller?.create === "function";
    value.send = value.list && typeof controller?.prompt === "function" && typeof ctx.on === "function";
    value.stream = value.send;
    value.rename = value.list && typeof controller?.rename === "function";
    value.cancel = value.list && typeof controller?.cancel === "function";
    // The verified public query has no archive-state projection. Do not
    // advertise management whose result cannot be read back truthfully.
    return value;
  };
  const records = async () => {
    if (!capabilities().list) throw fail("HOST_INCOMPATIBLE", 503);
    return await services().query.listSessions();
  };
  const requireSession = async (id) => {
    const record = (await records()).find((item) => item.header?.id === id);
    if (!record) throw fail("SESSION_NOT_FOUND", 404);
    return record;
  };
  const summary = async (record) => {
    const { query } = services();
    const title = typeof query.readTitle === "function" ? await query.readTitle(record.header.id) : undefined;
    const surface = typeof query.readSurface === "function" ? await query.readSurface(record.header.id) : undefined;
    const updatedAt = Math.max(record.header.createdAt, title?.updatedAt ?? 0, ...(surface?.events ?? []).map((event) => event.time));
    return { id: record.header.id, title: title?.title ?? record.header.id, updatedAt: iso(updatedAt), archived: false };
  };
  const json = (res, value, status = 200) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };

  async function stream(req, res, id, body) {
    if (!capabilities().send) throw fail("UNSUPPORTED_CAPABILITY");
    if (typeof body.text !== "string" || !body.text.trim()) throw fail("SCHEMA_INVALID", 400);
    if (busy.has(id)) throw fail("SESSION_BUSY");
    busy.add(id);
    const requestId = randomUUID();
    const disposers = [];
    let currentTurn, ownTurn, finalText = "", finished = false;
    const ownAttempts = new Set();
    let release;
    const finishedPromise = new Promise((resolve) => { release = resolve; });
    const write = (value) => {
      if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(value) + "\n");
    };
    const finish = (value) => {
      if (finished) return;
      finished = true;
      write(value);
      release();
    };
    // rpcId belongs to the native user message. Other terminal turns in this
    // shared session cannot prematurely complete this App submission.
    disposers.push(ctx.on("session/event", (session, event) => {
      if (session?.id !== id || finished) return;
      if (event.type === "turn/start") currentTurn = event.data.turn;
      if (event.type === "user/message" && messageOf(event)?.source?.rpcId === requestId) ownTurn = currentTurn;
      if (ownTurn === undefined || (event.data.turn !== undefined && event.data.turn !== ownTurn)) return;
      if (event.type === "assistant/message") finalText = textOf(event.data.message);
      if (event.type === "turn/end") {
        const reason = event.data.reason?.kind;
        finish(turnResult(reason, finalText));
      }
    }));
    disposers.push(ctx.on("agent/assistant-stream", (payload) => {
      const frame = payload?.frame;
      if (payload?.agent?.session?.id !== id || ownTurn === undefined) return;
      if (frame?.type === "start" && frame.turn === ownTurn) ownAttempts.add(frame.attemptId);
      if (frame?.type === "chunk" && ownAttempts.has(frame.attemptId)
          && frame.chunk?.type === "text-delta") write({ type: "delta", text: frame.chunk.text });
      if (frame?.type === "end") ownAttempts.delete(frame.attemptId);
    }));
    const abort = new AbortController();
    const closed = () => { abort.abort(); release(); };
    res.on("close", closed);
    const timer = setTimeout(() => finish({ type: "error", code: "AGENT_TIMEOUT" }), 30 * 60 * 1000);
    try {
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      const receipt = await services().controller.prompt({ requestId, sessionId: id, mode: "queue", content: [{ type: "text", text: body.text }] }, abort.signal);
      if (receipt?.accepted !== true) throw fail("AGENT_REJECTED");
      await finishedPromise;
      if (!res.destroyed && !res.writableEnded) res.end();
    } catch (error) {
      finish({ type: "error", code: error.code ?? "AGENT_UNAVAILABLE" });
      if (!res.destroyed && !res.writableEnded) res.end();
    } finally {
      clearTimeout(timer);
      res.off("close", closed);
      for (const dispose of disposers) dispose();
      busy.delete(id);
    }
  }

  return async (req, res) => {
    try {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail("AUTHENTICATION_REQUIRED", 401);
      const url = new URL(req.url, "http://localhost");
      if (url.search) throw fail("SCHEMA_INVALID", 400);
      const path = url.pathname;
      if (req.method === "GET" && path === PREFIX + "/status") {
        const caps = capabilities();
        // Call the actual query. An installed plugin with a broken persistence
        // backend must never report online merely because functions exist.
        await records();
        return json(res, { online: caps.list && caps.history, capabilities: caps });
      }
      if (path === PREFIX + "/sessions") {
        if (req.method === "GET") return json(res, { sessions: await Promise.all((await records()).map(summary)) });
        if (req.method === "POST") {
          if (!capabilities().create) throw fail("UNSUPPORTED_CAPABILITY");
          const body = await bodyOf(req);
          if (Object.keys(body).some((key) => key !== "title")) throw fail("SCHEMA_INVALID", 400);
          if (body.title != null && (typeof body.title !== "string" || !body.title.trim())) throw fail("SCHEMA_INVALID", 400);
          if (body.title && !capabilities().rename) throw fail("UNSUPPORTED_CAPABILITY");
          const created = await services().controller.create({ sessionId: randomUUID(), cwd: config.cwd, agentPreset: config.agentPreset });
          if (body.title) await services().controller.rename({ sessionId: created.sessionId, title: body.title });
          return json(res, { session: await summary(await requireSession(created.sessionId)) });
        }
      }
      const match = new RegExp(`^${PREFIX}/sessions/([^/]+)/(history|messages|rename|archive|delete|cancel)$`).exec(path);
      if (!match) throw fail("NOT_FOUND", 404);
      let id;
      try { id = decodeURIComponent(match[1]); } catch { throw fail("SCHEMA_INVALID", 400); }
      const action = match[2];
      await requireSession(id);
      if (req.method === "GET" && action === "history") {
        if (!capabilities().history) throw fail("UNSUPPORTED_CAPABILITY");
        const snapshot = await services().query.readSurface(id);
        const messages = snapshot.events.filter((event) => ["user/message", "assistant/message"].includes(event.type))
          .map((event) => {
            const message = messageOf(event);
            if (typeof message?.id !== "string" || !["user", "assistant"].includes(message.role) || !Array.isArray(message.content)) throw fail("HOST_INCOMPATIBLE", 502);
            return { id: message.id, role: message.role, text: textOf(message), createdAt: iso(event.time) };
          });
        return json(res, { messages });
      }
      if (req.method !== "POST") throw fail("NOT_FOUND", 404);
      const body = await bodyOf(req);
      if (action === "messages") {
        if (Object.keys(body).some((key) => key !== "text")) throw fail("SCHEMA_INVALID", 400);
        return await stream(req, res, id, body);
      }
      if (Object.keys(body).some((key) => key !== "value")) throw fail("SCHEMA_INVALID", 400);
      if (!capabilities()[action]) throw fail("UNSUPPORTED_CAPABILITY");
      const { controller, registry } = services();
      if (action === "rename") {
        if (typeof body.value !== "string" || !body.value.trim()) throw fail("SCHEMA_INVALID", 400);
        await controller.rename({ sessionId: id, title: body.value });
      } else if (action === "archive") {
        if (typeof body.value !== "boolean") throw fail("SCHEMA_INVALID", 400);
        await registry[body.value ? "archiveSession" : "unarchiveSession"](id);
      } else if (action === "cancel") {
        const result = await controller.cancel({ sessionId: id });
        if (result?.accepted !== true) throw fail("CANCEL_REJECTED");
      }
      return json(res, { id, action, ...(action === "archive" ? { archived: body.value } : {}) });
    } catch (error) {
      if (!res.headersSent) json(res, { code: error.code ?? "AGENT_UNAVAILABLE" }, error.status ?? 503);
      else if (!res.writableEnded) res.end();
    }
  };
}

export function apply(ctx, config) {
  const token = process.env[config.tokenEnv];
  const handler = createSessionHandler(ctx, config, token);
  ctx.effect(() => {
    const server = createServer(handler);
    server.listen(config.port, "127.0.0.1");
    server.on("error", (error) => ctx.logger?.error?.("OAI session adapter listener failed: %s", error.code));
    return () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }, "oai-native-session-adapter");
}
