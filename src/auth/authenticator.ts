import { createHash, timingSafeEqual } from "node:crypto";

import { GatewayError, schemaInvalid } from "../shared/errors.js";
import type { VerifiedRequest } from "../shared/types.js";
import type { RawGatewayRequest } from "../http/contract.js";
import {
  canonicalRequestSignatureInput,
  canonicalRequestTarget,
  verifyEd25519Signature,
} from "../protocol/index.js";
import type { AccountStore } from "../store/contract.js";

/** 契约 §6.1：九个认证 header 必须各恰好出现一次。 */
export const AUTH_HEADERS = [
  "authorization",
  "x-open-android-intelligence-protocol",
  "x-open-android-intelligence-account",
  "x-open-android-intelligence-device",
  "x-open-android-intelligence-session",
  "x-open-android-intelligence-request-id",
  "x-open-android-intelligence-timestamp",
  "x-open-android-intelligence-nonce",
  "x-open-android-intelligence-signature",
] as const;

/** 契约 §5.5：登出路由只校验 Bearer 与五个身份 header。 */
export const LOGOUT_HEADERS = [
  "authorization",
  "x-open-android-intelligence-protocol",
  "x-open-android-intelligence-account",
  "x-open-android-intelligence-device",
  "x-open-android-intelligence-session",
] as const;

const CONDITIONAL_HEADERS = [
  "idempotency-key",
  "last-event-id",
  "content-type",
  "content-length",
  "digest",
] as const;

const WIRE_ID = /^[A-Za-z0-9._~-]{1,128}$/;
const UTC_MILLIS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const PROTOCOL_VERSION = "2.1";

export interface AuthenticatorOptions {
  readonly maxClockSkewMs?: number;
  readonly accessSessionLifetimeMs?: number;
  readonly nonceTtlMs?: number;
  readonly now?: () => number;
}

export interface AuthenticatorDeps {
  /** 按 accountId 打开账号存储；未知账号返回 undefined。 */
  readonly openStore: (accountId: string) => AccountStore | undefined;
  readonly options?: AuthenticatorOptions;
}

const headerMap = (headers: readonly { name: string; value: string }[]): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const header of headers) {
    const name = header.name.toLowerCase();
    const list = map.get(name) ?? [];
    list.push(header.value);
    map.set(name, list);
  }
  return map;
};

const singleton = (
  map: Map<string, string[]>,
  name: string,
  required: boolean,
): string | undefined => {
  const values = map.get(name);
  if (values === undefined) {
    if (required) throw schemaInvalid(`Missing required header: ${name}`);
    return undefined;
  }
  if (values.length !== 1) throw schemaInvalid(`Duplicate header: ${name}`);
  const value = values[0]!;
  if (/[\r\n\0]/.test(value)) throw schemaInvalid(`Control character in header: ${name}`);
  return value;
};

const assertIdentity = (value: string | undefined, label: string): string => {
  if (value === undefined || !WIRE_ID.test(value)) {
    throw schemaInvalid(`Invalid ${label}`);
  }
  return value;
};

const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const constantTimeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * 把原始 HTTP 请求转换为已认证身份。
 *
 * 顺序按契约 §6：单例 header → 协议版本 → Bearer 会话 → 身份逐字节一致 →
 * 时间窗 → nonce → canonical target → 签名 → 幂等 header 形状。
 * 任何失败都返回契约错误码，且不向业务暴露半验证状态。
 */
export class RequestAuthenticator {
  readonly #deps: AuthenticatorDeps;
  readonly #maxClockSkewMs: number;
  readonly #nonceTtlMs: number;
  readonly #now: () => number;

  constructor(deps: AuthenticatorDeps) {
    this.#deps = deps;
    this.#maxClockSkewMs = deps.options?.maxClockSkewMs ?? 120_000;
    this.#nonceTtlMs = deps.options?.nonceTtlMs ?? 240_000;
    this.#now = deps.options?.now ?? (() => Date.now());
  }

  #openStore(accountId: string): { store: AccountStore } {
    const store = this.#deps.openStore(accountId);
    if (store === undefined) {
      throw schemaInvalid("Unknown account");
    }
    return { store };
  }

  #bearer(map: Map<string, string[]>): { token: string; accountId: string; deviceId: string; sessionId: string } {
    const authorization = singleton(map, "authorization", true)!;
    if (!authorization.startsWith("Bearer ")) {
      throw schemaInvalid("Malformed Authorization header");
    }
    const token = authorization.slice("Bearer ".length);
    if (token.length === 0 || token !== token.trim() || /[\s,]/.test(token)) {
      throw schemaInvalid("Malformed bearer token");
    }
    const accountId = assertIdentity(singleton(map, "x-open-android-intelligence-account", true), "account header");
    const deviceId = assertIdentity(singleton(map, "x-open-android-intelligence-device", true), "device header");
    const sessionId = assertIdentity(singleton(map, "x-open-android-intelligence-session", true), "session header");
    const protocol = singleton(map, "x-open-android-intelligence-protocol", true)!;
    if (protocol !== PROTOCOL_VERSION) {
      throw schemaInvalid("Unsupported protocol header");
    }
    return { token, accountId, deviceId, sessionId };
  }

  /** 契约 §5.5：登出只做 Bearer 与身份绑定校验。 */
  async verifyLogout(request: RawGatewayRequest): Promise<VerifiedRequest> {
    const map = headerMap(request.headers);
    for (const header of LOGOUT_HEADERS) singleton(map, header, true);
    for (const header of CONDITIONAL_HEADERS) {
      if (header === "content-length" || header === "content-type") continue;
      singleton(map, header, false);
    }
    const identity = this.#bearer(map);
    const { store } = this.#openStore(identity.accountId);
    const session = store.findAccessSessionByTokenHash(sha256Hex(identity.token));
    const now = this.#now();
    if (
      session === undefined ||
      !constantTimeEqual(session.tokenHash, sha256Hex(identity.token)) ||
      !constantTimeEqual(session.sessionId, identity.sessionId) ||
      !constantTimeEqual(session.deviceId, identity.deviceId) ||
      session.revokedAt !== null ||
      Date.parse(session.expiresAt) <= now
    ) {
      throw new GatewayError("AUTHENTICATION_REQUIRED");
    }
    const device = store.getDevice(identity.deviceId);
    if (device === undefined || device.revokedAt !== null) {
      throw new GatewayError("PAIRING_REQUIRED");
    }
    return {
      method: request.method,
      target: request.target,
      path: pathOf(request.target),
      query: queryOf(request.target),
      requestId: singleton(map, "x-open-android-intelligence-request-id", false) ?? "logout",
      correlationId: singleton(map, "x-open-android-intelligence-request-id", false) ?? "logout",
      accountId: identity.accountId,
      deviceId: identity.deviceId,
      sessionId: identity.sessionId,
      device,
      body: request.body,
      bodyText: request.bodyText,
      json: request.json,
      idempotencyKey: null,
      contentType: singleton(map, "content-type", false) ?? null,
      contentLength: singleton(map, "content-length", false) === undefined
        ? null
        : Number.parseInt(singleton(map, "content-length", false)!, 10),
      headers: request.headers,
    };
  }

  /** 完整的契约 §6 认证。 */
  async verify(request: RawGatewayRequest): Promise<VerifiedRequest> {
    const method = request.method;
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw schemaInvalid("Unsupported method");
    }
    const map = headerMap(request.headers);
    for (const header of AUTH_HEADERS) singleton(map, header, true);

    const identity = this.#bearer(map);
    const requestId = assertIdentity(
      singleton(map, "x-open-android-intelligence-request-id", true),
      "request id",
    );
    const timestamp = singleton(map, "x-open-android-intelligence-timestamp", true)!;
    if (!UTC_MILLIS.test(timestamp) || new Date(timestamp).toISOString() !== timestamp) {
      throw schemaInvalid("Invalid timestamp");
    }
    const nonce = singleton(map, "x-open-android-intelligence-nonce", true)!;
    const signature = singleton(map, "x-open-android-intelligence-signature", true)!;

    const idempotencyKey = singleton(map, "idempotency-key", false) ?? null;
    const mutating = method !== "GET";
    if (mutating && idempotencyKey === null) {
      throw schemaInvalid("Idempotency-Key is required for mutating requests");
    }
    if (!mutating && idempotencyKey !== null) {
      throw schemaInvalid("Idempotency-Key is forbidden on GET");
    }
    if (idempotencyKey !== null && idempotencyKey !== requestId) {
      throw schemaInvalid("Idempotency-Key must equal the signed request id");
    }

    const { store } = this.#openStore(identity.accountId);
    const tokenHash = sha256Hex(identity.token);
    const session = store.findAccessSessionByTokenHash(tokenHash);
    const now = this.#now();
    if (session === undefined) throw new GatewayError("AUTHENTICATION_REQUIRED");
    if (session.revokedAt !== null) throw new GatewayError("SESSION_REVOKED");
    if (Date.parse(session.expiresAt) <= now) throw new GatewayError("SESSION_EXPIRED");
    if (session.sessionId !== identity.sessionId || session.deviceId !== identity.deviceId) {
      throw new GatewayError("AUTHENTICATION_FAILED");
    }
    const device = store.getDevice(identity.deviceId);
    if (device === undefined || device.revokedAt !== null) {
      throw new GatewayError("PAIRING_REQUIRED");
    }

    const age = Math.abs(now - Date.parse(timestamp));
    if (age > this.#maxClockSkewMs) throw new GatewayError("CLOCK_SKEWED");

    const canonicalTarget = canonicalRequestTarget(request.target);
    if (canonicalTarget !== request.target) {
      throw new GatewayError("NON_CANONICAL_TARGET");
    }

    const signatureBytes = Buffer.from(signature, "base64url");
    if (signatureBytes.length !== 64 || signatureBytes.toString("base64url") !== signature) {
      throw new GatewayError("SIGNATURE_INVALID");
    }
    const nonceBytes = Buffer.from(nonce, "base64url");
    if (nonceBytes.length !== 16 || nonceBytes.toString("base64url") !== nonce) {
      throw new GatewayError("SIGNATURE_INVALID");
    }

    // nonce 必须在验签成功后落库，避免伪造请求消耗合法 nonce。
    let preimage = canonicalRequestSignatureInput({
      method: method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
      target: request.target,
      accountId: identity.accountId,
      deviceId: identity.deviceId,
      sessionId: identity.sessionId,
      requestId,
      timestamp,
      nonce,
      body: request.body,
    });
    if (request.declaredBodyDigestHex !== undefined) {
      // 契约 §8：附件 content 的签名 body digest 来自 Digest header，而不是缓冲的字节。
      if (!/^[a-f0-9]{64}$/.test(request.declaredBodyDigestHex)) {
        throw new GatewayError("SIGNATURE_INVALID");
      }
      const text = new TextDecoder().decode(preimage);
      const lines = text.split("\n");
      lines[lines.length - 1] = request.declaredBodyDigestHex;
      preimage = new TextEncoder().encode(lines.join("\n"));
    }
    if (!verifyEd25519Signature(device.publicKey, preimage, signature)) {
      throw new GatewayError("SIGNATURE_INVALID");
    }

    if (store.hasNonce(nonce)) throw new GatewayError("REQUEST_REPLAYED");
    store.recordNonce(nonce, new Date(now + this.#nonceTtlMs).toISOString());
    // 手机端会每 5 秒轮询配对状态；顺手清理过期 nonce，避免表无界增长。
    store.pruneNonces(new Date(now).toISOString());

    return {
      method,
      target: request.target,
      path: pathOf(request.target),
      query: queryOf(request.target),
      requestId,
      correlationId: requestId,
      accountId: identity.accountId,
      deviceId: identity.deviceId,
      sessionId: identity.sessionId,
      device,
      body: request.body,
      bodyText: request.bodyText,
      json: request.json,
      idempotencyKey,
      contentType: singleton(map, "content-type", false) ?? null,
      contentLength: (() => {
        const raw = singleton(map, "content-length", false);
        if (raw === undefined) return null;
        const parsed = Number.parseInt(raw, 10);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
      })(),
      headers: request.headers,
    };
  }
}

export const pathOf = (target: string): string => {
  const index = target.indexOf("?");
  return index === -1 ? target : target.slice(0, index);
};

export const queryOf = (target: string): URLSearchParams => {
  const index = target.indexOf("?");
  return new URLSearchParams(index === -1 ? "" : target.slice(index + 1));
};
