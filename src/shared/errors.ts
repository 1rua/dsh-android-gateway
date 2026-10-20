/**
 * 契约 §14 的 wire 错误码闭集。只允许这些值出现在响应的 `error.code` 中，
 * 内部异常一律折叠为 `INTERNAL_ERROR`，避免把宿主细节泄露给客户端。
 */
export const GATEWAY_ERROR_CODES = [
  "PROTOCOL_INCOMPATIBLE",
  "SCHEMA_INVALID",
  "TLS_IDENTITY_REQUIRED",
  "ACCOUNT_NOT_FOUND",
  "AUTHENTICATION_REQUIRED",
  "AUTHENTICATION_FAILED",
  "REFRESH_REUSED",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
  "IDENTITY_OVERRIDE_REJECTED",
  "SIGNATURE_INVALID",
  "NON_CANONICAL_TARGET",
  "REQUEST_REPLAYED",
  "CLOCK_SKEWED",
  "PAIRING_REQUIRED",
  "PAIRING_INVITATION_EXPIRED",
  "PAIRING_GENERATION_STALE",
  "GRANT_REQUIRED",
  "GRANT_STALE",
  "CAPABILITY_UNAVAILABLE",
  "PROVIDER_CHANGED",
  "IDEMPOTENCY_CONFLICT",
  "OUTCOME_UNKNOWN",
  "ATTACHMENT_DIGEST_MISMATCH",
  "ATTACHMENT_STORAGE_UNAVAILABLE",
  "ATTACHMENT_EXPIRED",
  "CURSOR_CONFLICT",
  "CURSOR_EXPIRED",
  "APPROVAL_NOT_FOUND",
  "APPROVAL_EXPIRED",
  "APPROVAL_ALREADY_RESOLVED",
  "APPROVAL_DECISION_INVALID",
  "RATE_LIMITED",
  "HOST_INCOMPATIBLE",
  "ACCOUNT_DELETING",
  "INTERNAL_ERROR",
  // 契约 §7 会话管理补充码（App 的 ConversationClient 会识别它们）
  "CONVERSATION_BUSY",
  "CONVERSATION_ARCHIVED",
  "CONVERSATION_NOT_FOUND",
  // 消息级失败码（契约 §9 conversation.message.status 的 errorCode 闭集）
  "AGENT_UNAVAILABLE",
  "AGENT_MEDIA_REJECTED",
  "ORGANIZATION_CONFLICT",
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

const RETRYABLE: ReadonlySet<GatewayErrorCode> = new Set([
  "RATE_LIMITED",
  "ATTACHMENT_STORAGE_UNAVAILABLE",
  "OUTCOME_UNKNOWN",
]);

export interface GatewayErrorJson {
  readonly code: GatewayErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly details: Record<string, unknown>;
}

/** 带契约错误码的异常；HTTP 层把它映射为失败信封。 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly details: Record<string, unknown>;
  readonly httpStatus: number | undefined;

  constructor(
    code: GatewayErrorCode,
    message?: string,
    options: {
      retryAfterSeconds?: number | null;
      details?: Record<string, unknown>;
      httpStatus?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message ?? code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GatewayError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.details = options.details ?? {};
    this.httpStatus = options.httpStatus;
  }

  toJson(): GatewayErrorJson {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      retryAfterSeconds: this.retryAfterSeconds,
      details: this.details,
    };
  }
}

export const schemaInvalid = (message = "Request does not match the negotiated schema"): GatewayError =>
  new GatewayError("SCHEMA_INVALID", message);

export const internalError = (cause: unknown): GatewayError =>
  new GatewayError("INTERNAL_ERROR", "Gateway internal error", { cause });

/** 未知异常统一折叠；已带契约码的异常原样保留。 */
export const asGatewayError = (error: unknown): GatewayError =>
  error instanceof GatewayError
    ? error
    : internalError(error);
