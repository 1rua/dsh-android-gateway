import type { ServerResponse } from "node:http";

import type { GatewayErrorCode } from "../shared/errors.js";
import { GatewayError } from "../shared/errors.js";
import { createWireId } from "../shared/ids.js";
import type { GatewayResult, JsonObject } from "../shared/types.js";

import { PROTOCOL_VERSION } from "./headers.js";

/**
 * 预认证请求没有签名 requestId；按宿主约定生成 `req_<随机 wire id>`，
 * 保证 envelope 始终有两个合法 wire ID 可供客户端关联。
 */
export const createGeneratedIdentity = (): EnvelopeIdentity => {
  const requestId = createWireId("req_");
  return { requestId, correlationId: requestId };
};

/**
 * 契约 §14 + 任务约定的错误码 → HTTP 状态映射。
 * 未列出的调用方错误一律 400；`GatewayError.httpStatus` 可显式覆盖（core 使用）。
 */
const ERROR_STATUS_BY_CODE: Readonly<Partial<Record<GatewayErrorCode, number>>> = {
  AUTHENTICATION_REQUIRED: 401,
  AUTHENTICATION_FAILED: 401,
  SIGNATURE_INVALID: 401,
  SCHEMA_INVALID: 400,
  NON_CANONICAL_TARGET: 400,
  CLOCK_SKEWED: 400,
  REQUEST_REPLAYED: 409,
  PROTOCOL_INCOMPATIBLE: 406,
  CURSOR_CONFLICT: 409,
  CURSOR_EXPIRED: 410,
  CONVERSATION_BUSY: 409,
  CONVERSATION_ARCHIVED: 409,
  CONVERSATION_NOT_FOUND: 404,
  ORGANIZATION_CONFLICT: 409,
  SESSION_EXPIRED: 401,
  SESSION_REVOKED: 401,
  PAIRING_REQUIRED: 403,
  PAIRING_INVITATION_EXPIRED: 410,
  PAIRING_GENERATION_STALE: 409,
  GRANT_STALE: 409,
  IDENTITY_OVERRIDE_REJECTED: 403,
  IDEMPOTENCY_CONFLICT: 409,
  ATTACHMENT_EXPIRED: 404,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_EXPIRED: 410,
  APPROVAL_ALREADY_RESOLVED: 409,
  APPROVAL_DECISION_INVALID: 400,
  CAPABILITY_UNAVAILABLE: 501,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export const httpStatusForError = (error: GatewayError): number =>
  error.httpStatus ?? ERROR_STATUS_BY_CODE[error.code] ?? 400;

/** envelope 顶层要求的两个 ID；失败时也必须有值。 */
export interface EnvelopeIdentity {
  readonly requestId: string;
  readonly correlationId: string;
}

export const createSuccessEnvelope = (
  result: GatewayResult,
  identity: EnvelopeIdentity,
): JsonObject => ({
  requestId: identity.requestId,
  correlationId: result.correlationId ?? identity.correlationId,
  protocol: PROTOCOL_VERSION,
  data: result.data,
});

export const createFailureEnvelope = (
  error: GatewayError,
  identity: EnvelopeIdentity,
): JsonObject => ({
  requestId: identity.requestId,
  correlationId: identity.correlationId,
  protocol: PROTOCOL_VERSION,
  // GatewayErrorJson 的 details 是 Record<string, unknown>，序列化后仍是 JSON 对象。
  error: error.toJson() as unknown as JsonObject,
});

export interface WriteEnvelopeOptions {
  /** 请求 body 未读完时关闭连接，避免半读状态污染 keep-alive。 */
  readonly closeConnection?: boolean;
}

const baseHeaders = (closeConnection: boolean | undefined): Record<string, string> => {
  // 所有响应都不得被缓存：错误信封与成功信封都携带每请求身份。
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (closeConnection === true) headers["Connection"] = "close";
  return headers;
};

const writeJsonEnvelope = (
  res: ServerResponse,
  status: number,
  envelope: JsonObject,
  options?: WriteEnvelopeOptions,
): void => {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = Buffer.from(JSON.stringify(envelope), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.byteLength),
    ...baseHeaders(options?.closeConnection),
  });
  res.end(body);
};

export const sendFailureEnvelope = (
  res: ServerResponse,
  error: GatewayError,
  identity: EnvelopeIdentity,
  options?: WriteEnvelopeOptions,
): void => {
  writeJsonEnvelope(res, httpStatusForError(error), createFailureEnvelope(error, identity), options);
};

export const sendSuccessResult = (
  res: ServerResponse,
  result: GatewayResult,
  identity: EnvelopeIdentity,
  options?: WriteEnvelopeOptions,
): void => {
  // `raw` 用于非 JSON 响应（历史附件流等）；JSON 成功响应一律走契约信封。
  const raw = result.raw;
  if (raw === undefined) {
    writeJsonEnvelope(res, result.status, createSuccessEnvelope(result, identity), options);
    return;
  }
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = Buffer.from(raw.body);
  res.writeHead(result.status, {
    ...raw.headers,
    "Content-Type": raw.contentType,
    "Content-Length": String(body.byteLength),
    ...baseHeaders(options?.closeConnection),
  });
  res.end(body);
};
