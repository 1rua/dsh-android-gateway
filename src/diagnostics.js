/** 可选的阶段诊断；追踪头不授予身份或权限。 */
import { randomUUID } from "node:crypto";

const bootId = randomUUID();
const identity = /^[A-Za-z0-9._~:-]{1,1024}$/;
const requestIdentity = /^[A-Za-z0-9._~-]{1,128}$/;
const parent = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const stages = new Set(["adapter.dsh.create_submitted", "adapter.dsh.create_returned",
  "adapter.dsh.message_received", "adapter.dsh.host_submitted", "adapter.dsh.native_user_event",
  "adapter.dsh.first_content_event", "adapter.dsh.native_terminal", "adapter.dsh.observer_closed"]);

export function diagnosticTrace(headers = {}) {
  if (process.env.OAI_DSH_ADAPTER_DIAGNOSTICS !== "1") return () => {};
  const match = parent.exec(typeof headers.traceparent === "string" ? headers.traceparent : "");
  const traceId = match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2])
    ? match[1] : randomUUID().replaceAll("-", "");
  const candidate = headers["x-oai-request-id"];
  const requestId = typeof candidate === "string" && requestIdentity.test(candidate) ? candidate : undefined;
  const started = process.hrtime.bigint();
  return (stage, fields = {}) => {
    if (!stages.has(stage)) return;
    const now = process.hrtime.bigint();
    const record = { stage, bootId, traceId, requestId,
      monotonicNs: now.toString(), wallTimeMs: Date.now(), elapsedMs: Number(now - started) / 1e6 };
    for (const key of ["clientMessageId", "conversationId", "userMessageId", "messageId"]) {
      if (typeof fields[key] === "string" && identity.test(fields[key])) record[key] = fields[key];
    }
    if (["completed", "unknown", "failed", "cancelled"].includes(fields.state)) record.state = fields.state;
    try { process.stderr.write(`oai_native ${JSON.stringify(record)}\n`); } catch { /* 诊断失败不改变执行结果。 */ }
  };
}
