import { GatewayError } from "../shared/errors.js";
import { isWireId } from "../shared/ids.js";

import type { RawHeader } from "./contract.js";

/** 契约 §2 的协议版本字符串；envelope 与协议 header 都必须精确等于它。 */
export const PROTOCOL_VERSION = "2.1";

/** 契约 §1.1：所有端点都挂在唯一固定前缀下。 */
export const DEFAULT_MOUNT_PATH = "/open-android-intelligence/v2";

/** 契约 §2：线上 method 区分大小写，只允许这五个值，禁止 toUpperCase 别名。 */
export const GATEWAY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type GatewayMethod = (typeof GATEWAY_METHODS)[number];

/** 九个认证 header 的小写形式（契约 §6.1）。 */
export const AUTHORIZATION_HEADER = "authorization";
export const PROTOCOL_HEADER = "x-open-android-intelligence-protocol";
export const ACCOUNT_HEADER = "x-open-android-intelligence-account";
export const DEVICE_HEADER = "x-open-android-intelligence-device";
export const SESSION_HEADER = "x-open-android-intelligence-session";
export const REQUEST_ID_HEADER = "x-open-android-intelligence-request-id";
export const TIMESTAMP_HEADER = "x-open-android-intelligence-timestamp";
export const NONCE_HEADER = "x-open-android-intelligence-nonce";
export const SIGNATURE_HEADER = "x-open-android-intelligence-signature";

export const AUTHENTICATION_HEADER_NAMES = [
  AUTHORIZATION_HEADER,
  PROTOCOL_HEADER,
  ACCOUNT_HEADER,
  DEVICE_HEADER,
  SESSION_HEADER,
  REQUEST_ID_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  SIGNATURE_HEADER,
] as const;

/** 五个条件 header 的小写形式（契约 §6.1）。 */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const LAST_EVENT_ID_HEADER = "last-event-id";
export const CONTENT_TYPE_HEADER = "content-type";
export const CONTENT_LENGTH_HEADER = "content-length";
export const DIGEST_HEADER = "digest";

export const CONDITIONAL_HEADER_NAMES = [
  IDEMPOTENCY_KEY_HEADER,
  LAST_EVENT_ID_HEADER,
  CONTENT_TYPE_HEADER,
  CONTENT_LENGTH_HEADER,
  DIGEST_HEADER,
] as const;

/** 契约 §6.1 要求从 raw header 列表证明单例的十四个 header。 */
export const CONTRACT_HEADER_NAMES = [
  ...AUTHENTICATION_HEADER_NAMES,
  ...CONDITIONAL_HEADER_NAMES,
] as const;

const AUTHENTICATION_HEADER_SET: ReadonlySet<string> = new Set(AUTHENTICATION_HEADER_NAMES);
const CONTRACT_HEADER_SET: ReadonlySet<string> = new Set(CONTRACT_HEADER_NAMES);
const GATEWAY_METHOD_SET: ReadonlySet<string> = new Set(GATEWAY_METHODS);

const WHITESPACE = new Set(["\t", " "]);

export const isGatewayMethod = (method: string): method is GatewayMethod =>
  GATEWAY_METHOD_SET.has(method);

export const lowerHeaderName = (name: string): string => name.toLowerCase();

/**
 * 从 `IncomingMessage.rawHeaders` 重建原始 header 列表。
 *
 * 契约 §6.1 要求从 framework 合并、折叠或 first/last 选择之前的列表证明单例，
 * 所以这里绝不能使用 `req.headers`。拿不到 raw 列表时按契约失败关闭。
 */
export const collectRawHeaders = (rawHeaders: readonly string[] | undefined): readonly RawHeader[] => {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) {
    throw new GatewayError("AUTHENTICATION_REQUIRED", "The raw header list is unavailable");
  }
  const headers: RawHeader[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== "string" || typeof value !== "string" || name.length === 0) {
      throw new GatewayError("AUTHENTICATION_REQUIRED", "The raw header list is malformed");
    }
    headers.push({ name, value });
  }
  return headers;
};

/** 某个 header 在原始列表中的全部值（保持发送顺序）。 */
export const headerValues = (headers: readonly RawHeader[], name: string): string[] => {
  const needle = name.toLowerCase();
  const values: string[] = [];
  for (const header of headers) {
    if (header.name.toLowerCase() === needle) values.push(header.value);
  }
  return values;
};

export const headerCount = (headers: readonly RawHeader[], name: string): number =>
  headerValues(headers, name).length;

/**
 * 读取经过单例校验后的 header 值；不存在返回 null。
 * 调用方应先执行 `validateContractHeaders`，这里重复只作为防御性内部错误。
 */
export const headerValue = (headers: readonly RawHeader[], name: string): string | null => {
  const values = headerValues(headers, name);
  if (values.length > 1) {
    throw new GatewayError("SCHEMA_INVALID", `Header ${name} must appear at most once`);
  }
  return values[0] ?? null;
};

/** 认证 header 缺失/重复时失败关闭，避免未认证请求进入业务。 */
export const requireAuthenticationHeaders = (headers: readonly RawHeader[]): void => {
  for (const name of AUTHENTICATION_HEADER_NAMES) {
    const occurrences = headerCount(headers, name);
    if (occurrences !== 1) {
      throw new GatewayError("AUTHENTICATION_REQUIRED", `Header ${name} must appear exactly once`, {
        details: { header: name, occurrences },
      });
    }
  }
};

/**
 * 契约 §5.5：登出路由只校验 Bearer 和五个身份/协议 header，
 * 不做时间/nonce/签名，因此其余四个认证 header 不要求出现。
 */
const LOGOUT_REQUIRED_HEADERS = [
  AUTHORIZATION_HEADER,
  PROTOCOL_HEADER,
  ACCOUNT_HEADER,
  DEVICE_HEADER,
  SESSION_HEADER,
] as const;

export const requireLogoutHeaders = (headers: readonly RawHeader[]): void => {
  for (const name of LOGOUT_REQUIRED_HEADERS) {
    const occurrences = headerCount(headers, name);
    if (occurrences !== 1) {
      throw new GatewayError("AUTHENTICATION_REQUIRED", `Header ${name} must appear exactly once`, {
        details: { header: name, occurrences },
      });
    }
  }
};

const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // 契约 §6.1：CR/LF/NUL 以及其他控制字符（含 HTAB）一律拒绝。
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const needsTrimming = (value: string): boolean =>
  value.length > 0 &&
  (WHITESPACE.has(value.charAt(0)) || WHITESPACE.has(value.charAt(value.length - 1)));

/** 认证 header 的问题按未认证处理（401），条件 header 的问题按请求非法处理（400）。 */
const rejectHeader = (name: string, message: string): never => {
  if (AUTHENTICATION_HEADER_SET.has(name)) {
    throw new GatewayError("AUTHENTICATION_REQUIRED", message, { details: { header: name } });
  }
  throw new GatewayError("SCHEMA_INVALID", message, { details: { header: name } });
};

/**
 * 契约 §6.1 的十四个 header 单例与原始值规则：
 * 重复（哪怕值完全相同）、逗号折叠值、需要 trim 才合法的值、含控制字符的值都拒绝。
 */
export const validateContractHeaders = (headers: readonly RawHeader[]): void => {
  const counts = new Map<string, number>();
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (!CONTRACT_HEADER_SET.has(name)) continue;

    const next = (counts.get(name) ?? 0) + 1;
    counts.set(name, next);
    if (hasControlCharacters(header.value)) {
      rejectHeader(name, `Header ${name} contains control characters`);
    }
    if (needsTrimming(header.value)) {
      rejectHeader(name, `Header ${name} must not require trimming`);
    }
    // 逗号折叠意味着中间件已经合并过多行，无法再证明单例。
    if (header.value.includes(",")) {
      rejectHeader(name, `Header ${name} contains a folded value`);
    }
  }

  for (const [name, occurrences] of counts) {
    if (occurrences > 1) {
      rejectHeader(name, `Header ${name} must appear at most once`);
    }
  }
};

/** 从认证 header 中读取 wire ID；不合法时返回 null，由 envelope 使用安全回退值。 */
export const headerWireId = (headers: readonly RawHeader[], name: string): string | null => {
  const value = headerValue(headers, name);
  return value !== null && isWireId(value) ? value : null;
};

/** 预认证 envelope 的 requestId：优先 body 里的 negotiationId，其次请求头。 */
export const requestIdFromHeaders = (headers: readonly RawHeader[]): string | null =>
  headerWireId(headers, REQUEST_ID_HEADER);

/** Content-Length 必须是十进制非负整数；返回 null 表示非法。 */
export const parseContentLengthValue = (value: string): number | null => {
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/** 请求是否声明了一个非零 entity-body（Transfer-Encoding 也算）。 */
export const declaresRequestBody = (headers: readonly RawHeader[]): boolean => {
  if (headerValue(headers, "transfer-encoding") !== null) return true;
  const rawLength = headerValue(headers, CONTENT_LENGTH_HEADER);
  if (rawLength === null) return false;
  const length = parseContentLengthValue(rawLength);
  return length !== null && length > 0;
};

/** 只按第一个字面量 `?` 切分 target；canonical 化由 protocol 层负责。 */
export interface RawTargetParts {
  readonly rawPath: string;
  readonly rawQuery: string;
  readonly hasQuery: boolean;
}

export const splitRawTarget = (target: string): RawTargetParts => {
  const queryIndex = target.indexOf("?");
  if (queryIndex === -1) return { rawPath: target, rawQuery: "", hasQuery: false };
  return {
    rawPath: target.slice(0, queryIndex),
    rawQuery: target.slice(queryIndex + 1),
    hasQuery: true,
  };
};

/**
 * 原始 query 中是否出现某个参数名。
 * 只用于「query 含 cursor 即走 SSE」的传输选择；canonical target 由 verifier 校验。
 */
export const rawQueryContains = (rawQuery: string, parameter: string): boolean => {
  for (const pair of rawQuery.split("&")) {
    if (pair.length === 0) continue;
    const equalsIndex = pair.indexOf("=");
    const rawName = equalsIndex === -1 ? pair : pair.slice(0, equalsIndex);
    let decodedName: string;
    try {
      decodedName = decodeURIComponent(rawName);
    } catch {
      // 畸形 percent-escape 留给 verifier 的 canonical target 校验处理。
      continue;
    }
    if (decodedName === parameter) return true;
  }
  return false;
};

/** Accept 是否显式要求 SSE（大小写不敏感，忽略参数，支持多次出现与逗号列表）。 */
export const acceptsEventStream = (headers: readonly RawHeader[]): boolean => {
  for (const value of headerValues(headers, "accept")) {
    for (const mediaRange of value.split(",")) {
      const mediaType = mediaRange.split(";")[0]?.trim().toLowerCase();
      if (mediaType === "text/event-stream") return true;
    }
  }
  return false;
};
