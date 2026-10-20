import { createHash } from "node:crypto";
import { mkdtemp, open as openFileHandle, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayError, asGatewayError } from "../shared/errors.js";
import type { JsonObject } from "../shared/types.js";

import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_JSON_BODY_BYTES,
  bodyTooLarge,
  readEntityBody,
} from "./body.js";
import type {
  AttachmentUploadFile,
  EventStreamService,
  GatewayCore,
  GatewayHttpHandler,
  GatewayHttpOptions,
  RawGatewayRequest,
  RawHeader,
  RequestVerifier,
} from "./contract.js";
import {
  createGeneratedIdentity,
  sendFailureEnvelope,
  sendSuccessResult,
  type EnvelopeIdentity,
} from "./envelope.js";
import {
  CONTENT_LENGTH_HEADER,
  CONTENT_TYPE_HEADER,
  DIGEST_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  LAST_EVENT_ID_HEADER,
  acceptsEventStream,
  declaresRequestBody,
  headerCount,
  headerValue,
  headerValues,
  collectRawHeaders,
  parseContentLengthValue,
  rawQueryContains,
  requestIdFromHeaders,
  requireAuthenticationHeaders,
  requireLogoutHeaders,
  validateContractHeaders,
} from "./headers.js";
import { matchRoute, normalizeMountPath, type GatewayRoute, type RouteMatch } from "./routes.js";
import { streamEventSubscription } from "./sse.js";

const CONTENT_ENCODING_HEADER = "content-encoding";
const TRANSFER_ENCODING_HEADER = "transfer-encoding";
const EMPTY_BODY = new Uint8Array(0);
const DEFAULT_HEARTBEAT_MS = 15_000;

interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface ResolvedOptions {
  readonly mountPath: string;
  readonly maxJsonBodyBytes: number;
  readonly maxAttachmentBytes: number;
  readonly heartbeatMs: number;
  readonly logger?: Logger;
}

const resolveOptions = (options: GatewayHttpOptions): ResolvedOptions => {
  const maxJsonBodyBytes = options.maxJsonBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isSafeInteger(maxJsonBodyBytes) || maxJsonBodyBytes <= 0) {
    throw new Error("maxJsonBodyBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes <= 0) {
    throw new Error("maxAttachmentBytes must be a positive safe integer");
  }
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 0) {
    throw new Error("heartbeatMs must be a non-negative finite number");
  }
  return {
    mountPath: normalizeMountPath(options.mountPath),
    maxJsonBodyBytes,
    maxAttachmentBytes,
    heartbeatMs,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };
};

const schemaInvalid = (message: string, details?: Record<string, unknown>): GatewayError =>
  new GatewayError("SCHEMA_INVALID", message, details === undefined ? {} : { details });

/** 只保留 path 部分写日志，避免 query/header 泄露到宿主日志。 */
const safePathForLog = (target: string): string => {
  const queryIndex = target.indexOf("?");
  const path = queryIndex === -1 ? target : target.slice(0, queryIndex);
  return path.length > 200 ? `${path.slice(0, 200)}…` : path;
};

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON decode 只作为便捷视图；失败留给 core 报 SCHEMA_INVALID，签名始终用原始字节。 */
const parseJsonObject = (text: string): JsonObject | null => {
  if (text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * 契约 §6.1 的路由级条件 header 规则。
 * 认证 header 是否单例、错误码按认证/条件 header 分级由 headers.ts 处理。
 */
const validateRouteHeaders = (
  headers: readonly RawHeader[],
  method: string,
  match: RouteMatch,
  config: ResolvedOptions,
): void => {
  const route: GatewayRoute = match.route;
  if (route.kind === "not-found") return;

  // Digest 只允许附件内容路由；Last-Event-ID 只允许 GET /events。
  if (route.kind !== "attachment-content" && headerCount(headers, DIGEST_HEADER) > 0) {
    throw schemaInvalid(`Header ${DIGEST_HEADER} is only allowed on attachment content uploads`);
  }
  if (route.kind !== "events" && headerCount(headers, LAST_EVENT_ID_HEADER) > 0) {
    throw schemaInvalid(`Header ${LAST_EVENT_ID_HEADER} is only allowed on GET /events`);
  }
  // JSON 请求禁止内容压缩；附件路由契约同样禁止。
  if (headerCount(headers, CONTENT_ENCODING_HEADER) > 0) {
    throw schemaInvalid("Content-Encoding is not supported by the gateway transport");
  }

  if (route.kind === "core" || route.kind === "events" || route.kind === "attachment-content") {
    requireAuthenticationHeaders(headers);
  } else if (route.kind === "logout") {
    requireLogoutHeaders(headers);
  }

  const idempotencyCount = headerCount(headers, IDEMPOTENCY_KEY_HEADER);
  const mutating = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  if (route.kind === "attachment-content") {
    if (idempotencyCount !== 1) {
      throw schemaInvalid("Idempotency-Key must appear exactly once on attachment content uploads");
    }
  } else if (route.kind !== "pre-auth" && route.kind !== "logout") {
    // 登出是契约 §5.5 的签名豁免路径，App 不发送 Idempotency-Key；
    // 其余认证请求按 §6.1 执行：GET 禁止、POST/PUT/PATCH/DELETE 恰好一次。
    if (method === "GET") {
      if (idempotencyCount !== 0) {
        throw schemaInvalid("Idempotency-Key must not appear on authenticated GET requests");
      }
    } else if (mutating && idempotencyCount !== 1) {
      throw schemaInvalid("Idempotency-Key must appear exactly once on authenticated mutating requests");
    }
  }

  if (route.kind === "attachment-content") return;

  const contentTypeCount = headerCount(headers, CONTENT_TYPE_HEADER);
  const contentLengthCount = headerCount(headers, CONTENT_LENGTH_HEADER);
  const transferEncoding = headerValue(headers, TRANSFER_ENCODING_HEADER);

  if (method === "GET" || method === "DELETE") {
    // 契约 §6.1：无 body 路由不得出现 Content-Type/Content-Length。
    if (contentTypeCount > 0) throw schemaInvalid(`Header ${CONTENT_TYPE_HEADER} must not appear on bodyless routes`);
    if (contentLengthCount > 0) throw schemaInvalid(`Header ${CONTENT_LENGTH_HEADER} must not appear on bodyless routes`);
    if (transferEncoding !== null) throw schemaInvalid("Transfer-Encoding must not appear on bodyless routes");
    return;
  }

  // 其余是 JSON entity-body 路由（POST/PUT/PATCH）。
  if (contentLengthCount > 1) {
    throw schemaInvalid(`Header ${CONTENT_LENGTH_HEADER} must appear at most once`);
  }
  const rawContentLength = headerValue(headers, CONTENT_LENGTH_HEADER);
  if (rawContentLength !== null) {
    const declaredLength = parseContentLengthValue(rawContentLength);
    if (declaredLength === null) {
      throw schemaInvalid(`${CONTENT_LENGTH_HEADER} must be a decimal byte count`);
    }
    if (declaredLength > config.maxJsonBodyBytes) {
      throw bodyTooLarge(config.maxJsonBodyBytes, declaredLength);
    }
  }
  if (contentTypeCount > 1) {
    throw schemaInvalid(`Header ${CONTENT_TYPE_HEADER} must appear at most once`);
  }
  const contentType = headerValue(headers, CONTENT_TYPE_HEADER);
  if (contentType === null) {
    if (declaresRequestBody(headers)) {
      throw schemaInvalid("Content-Type must be exactly application/json for JSON requests");
    }
  } else if (contentType !== "application/json") {
    throw schemaInvalid("Content-Type must be exactly application/json for JSON requests");
  }
};

const DIGEST_VALUE_PATTERN = /^sha-256=([A-Za-z0-9+/]{43}=)$/;

interface AttachmentContentHeaders {
  readonly contentLength: number;
  readonly digestHex: string;
  /** 保留 base64 形式，便于错误详情与诊断。 */
  readonly digestBase64: string;
}

const parseDigestHeader = (value: string): { base64: string; hex: string } => {
  const match = DIGEST_VALUE_PATTERN.exec(value);
  if (match === null) {
    throw schemaInvalid("Digest must be exactly sha-256=<base64 of 32 bytes>");
  }
  const base64 = match[1] as string;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength !== 32 || bytes.toString("base64") !== base64) {
    throw schemaInvalid("Digest must be exactly sha-256=<base64 of 32 bytes>");
  }
  return { base64, hex: bytes.toString("hex") };
};

/** 契约 §8.2：Content-Length 与 Digest 各恰好一次，禁止压缩与 chunked transfer。 */
const validateAttachmentContentHeaders = (
  headers: readonly RawHeader[],
  config: ResolvedOptions,
): AttachmentContentHeaders => {
  if (headerCount(headers, TRANSFER_ENCODING_HEADER) > 0) {
    throw schemaInvalid("Transfer-Encoding is forbidden on attachment content uploads");
  }
  if (headerCount(headers, CONTENT_ENCODING_HEADER) > 0) {
    throw schemaInvalid("Content-Encoding is forbidden on attachment content uploads");
  }
  const contentLengths = headerValues(headers, CONTENT_LENGTH_HEADER);
  if (contentLengths.length !== 1) {
    throw schemaInvalid("Content-Length must appear exactly once on attachment content uploads");
  }
  const contentLength = parseContentLengthValue(contentLengths[0] as string);
  if (contentLength === null) {
    throw schemaInvalid("Content-Length must be a decimal byte count");
  }
  if (contentLength > config.maxAttachmentBytes) {
    throw bodyTooLarge(config.maxAttachmentBytes, contentLength);
  }
  const digests = headerValues(headers, DIGEST_HEADER);
  if (digests.length !== 1) {
    throw schemaInvalid("Digest must appear exactly once on attachment content uploads");
  }
  const digest = parseDigestHeader(digests[0] as string);
  // Content-Type 允许 0/1 次；其值与已登记 mediaType 的一致性由 core 校验。
  if (headerCount(headers, CONTENT_TYPE_HEADER) > 1) {
    throw schemaInvalid(`Header ${CONTENT_TYPE_HEADER} must appear at most once`);
  }
  return { contentLength, digestHex: digest.hex, digestBase64: digest.base64 };
};

const readJsonRequest = async (
  req: IncomingMessage,
  headers: readonly RawHeader[],
  config: ResolvedOptions,
): Promise<{ readonly body: Uint8Array; readonly bodyText: string; readonly json: JsonObject | null }> => {
  const rawContentLength = headerValue(headers, CONTENT_LENGTH_HEADER);
  const declaredLength = rawContentLength === null ? null : parseContentLengthValue(rawContentLength);
  if (declaredLength !== null && declaredLength > config.maxJsonBodyBytes) {
    throw bodyTooLarge(config.maxJsonBodyBytes, declaredLength);
  }
  const body = await readEntityBody(req, config.maxJsonBodyBytes, declaredLength);
  const bodyText = Buffer.from(body).toString("utf8");
  return { body, bodyText, json: parseJsonObject(bodyText) };
};

const createRawRequest = (
  method: string,
  target: string,
  headers: readonly RawHeader[],
  body: Uint8Array,
  bodyText: string,
  json: JsonObject | null,
  declaredBodyDigestHex?: string,
): RawGatewayRequest =>
  declaredBodyDigestHex === undefined
    ? { method, target, headers, body, bodyText, json }
    : { method, target, headers, body, bodyText, json, declaredBodyDigestHex };

interface StagedAttachment {
  readonly upload: AttachmentUploadFile;
  readonly sha256Hex: string;
  readonly directory: string;
}

/**
 * 把附件 entity-body 流式写入 `os.tmpdir()` 下的私有目录并计算 SHA-256。
 * 无论成功失败都删除临时目录；内容长度与摘要由调用方再核对。
 */
const stageAttachmentBody = async (req: IncomingMessage, maxBytes: number): Promise<StagedAttachment> => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-android-gateway-upload-"));
  const filePath = join(directory, "content.bin");
  const hash = createHash("sha256");
  let receivedBytes = 0;
  let handle: FileHandle | undefined;

  try {
    handle = await openFileHandle(filePath, "wx", 0o600);
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      receivedBytes += buffer.byteLength;
      if (receivedBytes > maxBytes) throw bodyTooLarge(maxBytes, receivedBytes);
      hash.update(buffer);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset);
        if (bytesWritten <= 0) throw new Error("attachment staging write made no progress");
        offset += bytesWritten;
      }
    }
    await handle.close();
    handle = undefined;
    const sha256Hex = hash.digest("hex");
    return {
      upload: { filePath, contentLength: receivedBytes, sha256Hex },
      sha256Hex,
      directory,
    };
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // 关闭失败也要继续清理目录。
      }
    }
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof GatewayError) throw error;
    throw schemaInvalid("Failed to receive the attachment entity-body", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
};

interface DispatchState {
  identity: EnvelopeIdentity;
}

interface DispatchContext {
  readonly core: GatewayCore;
  readonly verifier: RequestVerifier;
  readonly events: EventStreamService;
  readonly config: ResolvedOptions;
}

const handlePreAuth = async (
  req: IncomingMessage,
  res: ServerResponse,
  context: DispatchContext,
  state: DispatchState,
  method: string,
  target: string,
  headers: readonly RawHeader[],
  route: Extract<GatewayRoute, { kind: "pre-auth" }>,
): Promise<void> => {
  const { body, bodyText, json } = await readJsonRequest(req, headers, context.config);
  const rawRequest = createRawRequest(method, target, headers, body, bodyText, json);
  const result =
    route.operation === "negotiate"
      ? await context.core.negotiate(rawRequest)
      : route.operation === "password"
        ? await context.core.passwordLogin(rawRequest)
        : route.operation === "refresh"
          ? await context.core.refresh(rawRequest)
          : route.operation === "invite-challenge"
            ? await context.core.inviteChallenge(rawRequest)
            : route.operation === "invite-exchange"
              ? await context.core.inviteExchange(rawRequest)
              : route.operation === "device-challenge"
                ? await context.core.deviceChallenge(rawRequest)
                : await context.core.deviceLogin(rawRequest);
  // 预认证没有签名 requestId：保留启动时生成的 req_<随机 wire id>，
  // core 若给出 correlationId 则由信封逻辑覆盖 correlationId。
  sendSuccessResult(res, result, state.identity);
};

const handleLogout = async (
  res: ServerResponse,
  context: DispatchContext,
  state: DispatchState,
  method: string,
  target: string,
  headers: readonly RawHeader[],
): Promise<void> => {
  const rawRequest = createRawRequest(method, target, headers, EMPTY_BODY, "", null);
  const verified = await context.verifier.verifyLogout(rawRequest);
  state.identity = { requestId: verified.requestId, correlationId: verified.correlationId };
  const result = await context.core.logout(verified);
  sendSuccessResult(res, result, state.identity);
};

const handleEvents = async (
  req: IncomingMessage,
  res: ServerResponse,
  context: DispatchContext,
  state: DispatchState,
  method: string,
  target: string,
  headers: readonly RawHeader[],
  match: RouteMatch,
): Promise<void> => {
  // SSE 与 JSON 事件列表使用同一路径；签名验证对两者一致，故先验签再选传输形态。
  const rawRequest = createRawRequest(method, target, headers, EMPTY_BODY, "", null);
  const verified = await context.verifier.verify(rawRequest);
  state.identity = { requestId: verified.requestId, correlationId: verified.correlationId };

  const wantsEventStream =
    acceptsEventStream(headers) || (match.hasQuery && rawQueryContains(match.rawQuery, "cursor"));
  const lastEventId = headerValue(headers, LAST_EVENT_ID_HEADER);

  if (!wantsEventStream && lastEventId === null) {
    const result = await context.core.handle(verified);
    sendSuccessResult(res, result, state.identity);
    return;
  }

  const cursorValues = verified.query.getAll("cursor");
  if (cursorValues.length > 1) {
    throw schemaInvalid("The canonical query must contain at most one cursor");
  }
  const cursorCandidate = cursorValues[0] ?? "";
  const cursor = cursorCandidate.length > 0 ? cursorCandidate : null;
  if (lastEventId !== null && (cursor === null || lastEventId !== cursor)) {
    throw new GatewayError("CURSOR_CONFLICT", "Last-Event-ID must be byte-identical to the query cursor", {
      details: { lastEventId, cursor },
    });
  }

  const subscription = await context.events.open(verified.accountId, cursor);
  await streamEventSubscription(req, res, subscription, {
    heartbeatMs: context.config.heartbeatMs,
    ...(context.config.logger === undefined ? {} : { logger: context.config.logger }),
  });
};

const handleAttachmentContent = async (
  req: IncomingMessage,
  res: ServerResponse,
  context: DispatchContext,
  state: DispatchState,
  method: string,
  target: string,
  headers: readonly RawHeader[],
): Promise<void> => {
  const { contentLength, digestHex } = validateAttachmentContentHeaders(headers, context.config);

  // 契约 §2.7.4：附件内容的签名预像用 Digest 声明的摘要，不读 body。
  // 因此这里先以空 body + declaredBodyDigestHex 验签，通过后才消费字节流。
  const rawRequest = createRawRequest(method, target, headers, EMPTY_BODY, "", null, digestHex);
  const verified = await context.verifier.verify(rawRequest);
  state.identity = { requestId: verified.requestId, correlationId: verified.correlationId };

  const staged = await stageAttachmentBody(req, context.config.maxAttachmentBytes);
  try {
    if (staged.upload.contentLength !== contentLength) {
      throw schemaInvalid("Received attachment bytes do not match Content-Length", {
        declaredLength: contentLength,
        receivedBytes: staged.upload.contentLength,
      });
    }
    if (staged.sha256Hex !== digestHex) {
      throw new GatewayError("ATTACHMENT_DIGEST_MISMATCH", "Uploaded bytes do not match the Digest header", {
        details: { expectedSha256: digestHex, actualSha256: staged.sha256Hex },
      });
    }
    const result = await context.core.uploadAttachmentContent(verified, staged.upload);
    sendSuccessResult(res, result, state.identity);
  } finally {
    await rm(staged.directory, { recursive: true, force: true }).catch((error: unknown) => {
      context.config.logger?.warn(
        `[dsh-android-gateway] failed to clean attachment staging directory: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
};

const handleCoreJson = async (
  req: IncomingMessage,
  res: ServerResponse,
  context: DispatchContext,
  state: DispatchState,
  method: string,
  target: string,
  headers: readonly RawHeader[],
): Promise<void> => {
  const { body, bodyText, json } = await readJsonRequest(req, headers, context.config);
  const rawRequest = createRawRequest(method, target, headers, body, bodyText, json);
  const verified = await context.verifier.verify(rawRequest);
  state.identity = { requestId: verified.requestId, correlationId: verified.correlationId };
  const result = await context.core.handle(verified);
  sendSuccessResult(res, result, state.identity);
};

const dispatch = async (
  req: IncomingMessage,
  res: ServerResponse,
  context: DispatchContext,
): Promise<void> => {
  const state: DispatchState = { identity: createGeneratedIdentity() };
  const method = typeof req.method === "string" ? req.method : "";
  const target = typeof req.url === "string" ? req.url : "";

  try {
    const headers = collectRawHeaders(req.rawHeaders);
    validateContractHeaders(headers);
    const match = matchRoute(method, target, context.config.mountPath);
    if (match.route.kind === "not-found") {
      throw new GatewayError("SCHEMA_INVALID", "Unknown gateway route", { httpStatus: 404 });
    }
    // 已认证路由的 envelope 应回显客户端签名过的 Request-Id（即使后续验签失败）；
    // 预认证请求没有签名 requestId，保留启动时生成的 req_<随机 wire id>。
    if (match.route.kind !== "pre-auth") {
      const requestId = requestIdFromHeaders(headers);
      if (requestId !== null) {
        state.identity = { requestId, correlationId: requestId };
      }
    }
    validateRouteHeaders(headers, method, match, context.config);

    switch (match.route.kind) {
      case "pre-auth":
        await handlePreAuth(req, res, context, state, method, target, headers, match.route);
        return;
      case "logout":
        await handleLogout(res, context, state, method, target, headers);
        return;
      case "events":
        await handleEvents(req, res, context, state, method, target, headers, match);
        return;
      case "attachment-content":
        await handleAttachmentContent(req, res, context, state, method, target, headers);
        return;
      case "core":
        await handleCoreJson(req, res, context, state, method, target, headers);
        return;
    }
  } catch (error) {
    const gatewayError = asGatewayError(error);
    context.config.logger?.error(
      `[dsh-android-gateway] ${method || "?"} ${safePathForLog(target)} failed: ${gatewayError.code}`,
    );
    if (res.headersSent) {
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          // 连接已被客户端断开。
        }
      }
      return;
    }
    sendFailureEnvelope(res, gatewayError, state.identity, { closeConnection: !req.complete });
    if (!req.complete) {
      // 请求 body 未读完时排空剩余字节，配合 Connection: close 结束这条连接。
      try {
        req.resume();
      } catch {
        // 已销毁的请求流忽略。
      }
    }
  }
};

/**
 * 创建 Gateway Protocol v2.1 的 HTTP handler。
 *
 * 所有语义（canonical target、签名、schema、幂等账本）都在 verifier/core；
 * 这一层只负责 raw header/单例证明、有界 body 读取、路由、信封与 SSE 帧写，
 * 并保证任何解析失败都折叠为契约信封、不把异常抛给 DSH。
 */
export const createGatewayHttpHandler = (
  core: GatewayCore,
  verifier: RequestVerifier,
  events: EventStreamService,
  options: GatewayHttpOptions = {},
): GatewayHttpHandler => {
  const config = resolveOptions(options);
  const context: DispatchContext = { core, verifier, events, config };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await dispatch(req, res, context);
    } catch (error) {
      // 最后兜底：dispatch 已处理常规失败，这里只防止极端情况下异常穿到宿主。
      const gatewayError = asGatewayError(error);
      config.logger?.error(
        `[dsh-android-gateway] unhandled transport failure: ${gatewayError.code}`,
      );
      if (!res.headersSent && !res.writableEnded) {
        try {
          sendFailureEnvelope(res, gatewayError, createGeneratedIdentity(), {
            closeConnection: !req.complete,
          });
        } catch {
          try {
            res.destroy();
          } catch {
            // 已断开。
          }
        }
      } else if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          // 已断开。
        }
      }
    }
  };
};
