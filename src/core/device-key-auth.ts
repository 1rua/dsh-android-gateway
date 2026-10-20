import { randomBytes } from "node:crypto";

import canonicalize from "canonicalize";

import { decodeCanonicalBase64Url, validateGatewayValue, verifyEd25519Signature } from "../protocol/index.js";
import { GatewayError } from "../shared/errors.js";
import { createWireId, isWireId, nowIso } from "../shared/ids.js";
import type { DeviceRecord, JsonObject } from "../shared/types.js";
import type { AccountManager } from "./accounts.js";
import type { NegotiationManager } from "./negotiation.js";

/** 设备会话签名的域分隔串；必须与 App 的 `loginWithDeviceKey` 逐字节一致。 */
export const DEVICE_SESSION_SIGNATURE_DOMAIN = "OPEN_ANDROID_INTELLIGENCE_DEVICE_SESSION_V1\n";

/** 设备挑战有效期：60 秒。 */
const CHALLENGE_TTL_MS = 60_000;
/** 进程内未兑换挑战上限，防止单个账号无限堆积内存。 */
const MAX_PENDING_CHALLENGES = 512;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const schemaInvalid = (message: string): GatewayError => new GatewayError("SCHEMA_INVALID", message);

const authenticationFailed = (message = "Device key authentication failed"): GatewayError =>
  new GatewayError("AUTHENTICATION_FAILED", message);

const pairingRequired = (message = "Device pairing is not active"): GatewayError =>
  new GatewayError("PAIRING_REQUIRED", message);

const rejectUnknownFields = (
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw schemaInvalid(`${label} has unknown field: ${key}`);
  }
};

export interface DeviceChallengeFacts {
  readonly challenge: string;
  readonly accountId: string;
  readonly negotiationId: string;
  readonly installationId: string;
  readonly deviceId: string;
  readonly nonce: string;
  readonly expiresAt: string;
}

export interface DeviceSessionResult {
  readonly accountId: string;
  readonly device: DeviceRecord;
}

export interface DeviceKeyAuthServiceOptions {
  readonly accounts: AccountManager;
  readonly negotiations: NegotiationManager;
  readonly logger?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  readonly now?: () => number;
}

interface DeviceChallengeBody {
  readonly accountId?: string;
  readonly username?: string;
  readonly negotiationId: string;
  readonly installationId: string;
  readonly deviceId: string;
}

interface DeviceSessionBody {
  readonly negotiationId: string;
  readonly accountId?: string;
  readonly username?: string;
  readonly installationId: string;
  readonly deviceId: string;
  readonly challenge: string;
  readonly signature: string;
}

interface PendingChallenge {
  readonly facts: DeviceChallengeFacts;
  readonly publicKey: string;
  readonly pairingGeneration: number;
  readonly expiresAt: number;
}

const parseChallengeBody = (json: JsonObject | null): DeviceChallengeBody => {
  if (!isObject(json)) throw schemaInvalid("Missing device challenge body");
  rejectUnknownFields(
    json,
    ["accountId", "username", "negotiationId", "installationId", "deviceId"],
    "device challenge",
  );
  const accountId = json.accountId;
  const username = json.username;
  const negotiationId = json.negotiationId;
  const installationId = json.installationId;
  const deviceId = json.deviceId;
  // 账号标识二选一：两个都给、都不给、或给空值都属于结构错误。
  const hasAccountId = Object.hasOwn(json, "accountId");
  const hasUsername = Object.hasOwn(json, "username");
  if (hasAccountId === hasUsername) {
    throw schemaInvalid("Exactly one of accountId or username is required");
  }
  if (hasAccountId && !isWireId(accountId)) throw schemaInvalid("accountId must be a wire id");
  if (hasUsername && (typeof username !== "string" || username.length === 0)) {
    throw schemaInvalid("username must be a non-empty string");
  }
  if (!isWireId(negotiationId)) throw schemaInvalid("negotiationId must be a wire id");
  if (!isWireId(installationId)) throw schemaInvalid("installationId must be a wire id");
  if (!isWireId(deviceId)) throw schemaInvalid("deviceId must be a wire id");
  const identifier: Pick<DeviceChallengeBody, "accountId" | "username"> = hasAccountId
    ? { accountId: accountId as string }
    : { username: username as string };
  return {
    ...identifier,
    negotiationId,
    installationId,
    deviceId,
  };
};

/**
 * 设备密钥会话（契约 §5.4）。
 *
 * 设备公钥是唯一长期签名根：挑战响应携带精确 7 字段事实，手机用已配对私钥
 * 对 `DEVICE_SESSION_V1\n + JCS(facts)` 签名；服务端验签成功后一次性消费挑战，
 * 再由 AuthService 沿用统一的 session/refresh 签发逻辑。
 *
 * 设备查找始终要求 `deviceId + installationId` 同时匹配，防止设备密钥跨账号
 * 或跨安装复用。
 */
export class DeviceKeyAuthService {
  readonly #options: DeviceKeyAuthServiceOptions;
  readonly #now: () => number;
  readonly #challenges = new Map<string, PendingChallenge>();

  constructor(options: DeviceKeyAuthServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  /** 设备挑战：确认目标设备存在、未撤销且安装一致后，返回精确 7 字段事实。 */
  challenge(json: JsonObject | null): DeviceChallengeFacts {
    const body = parseChallengeBody(json);
    const account = this.#resolveAccount(body);
    const store = this.#options.accounts.openStore(account.accountId);
    if (store === undefined) throw authenticationFailed();

    // 协商必须存在且绑定同一个安装；否则属于协议/协商过期。
    const negotiation = this.#options.negotiations.get(body.negotiationId, body.installationId);
    if (negotiation === undefined) {
      throw new GatewayError("PROTOCOL_INCOMPATIBLE", "Unknown or expired negotiation", {
        details: { negotiationId: body.negotiationId },
      });
    }
    // 协商声明的安装必须与设备挑战请求一致。
    if (negotiation.installationId !== body.installationId) throw authenticationFailed();

    const device = store.getDevice(body.deviceId);
    if (device === undefined || device.installationId !== body.installationId) {
      // 不确认设备是否存在：设备 ID 只在本账号内有效，错误信息不提供探测价值。
      throw authenticationFailed();
    }
    if (device.revokedAt !== null) throw pairingRequired();
    if (decodeCanonicalBase64Url(device.publicKey, 32) === undefined) {
      throw authenticationFailed("Device public key is invalid");
    }

    const now = this.#now();
    const facts: DeviceChallengeFacts = {
      challenge: createWireId("challenge_"),
      accountId: account.accountId,
      negotiationId: body.negotiationId,
      installationId: body.installationId,
      deviceId: body.deviceId,
      nonce: randomBytes(32).toString("base64url"),
      expiresAt: nowIso(new Date(now + CHALLENGE_TTL_MS)),
    };
    this.#pruneChallenges(now);
    this.#challenges.set(facts.challenge, {
      facts,
      publicKey: device.publicKey,
      pairingGeneration: device.pairingGeneration,
      expiresAt: Date.parse(facts.expiresAt),
    });
    return facts;
  }

  /**
   * 设备会话兑换：严格校验挑战 scope、设备当前状态与 Ed25519 签名；
   * 成功后一次性消费挑战并返回设备记录，供 AuthService 签发会话。
   */
  exchange(json: JsonObject | null): DeviceSessionResult {
    // `session.device` 是契约中的请求 Schema：六字段必填、accountId/username 二选一。
    const validation = validateGatewayValue("session.device", json);
    if (!validation.ok) throw schemaInvalid("Device session body does not match the contract");
    const body = json as unknown as DeviceSessionBody;

    const account = this.#resolveAccount(body);
    const store = this.#options.accounts.openStore(account.accountId);
    if (store === undefined) throw authenticationFailed();

    const now = this.#now();
    this.#pruneChallenges(now);
    const pending = this.#challenges.get(body.challenge);
    if (pending === undefined || pending.expiresAt <= now) throw authenticationFailed();

    // 挑战 scope 与请求逐字段比对；同时确认账号归属。
    if (
      pending.facts.challenge !== body.challenge ||
      pending.facts.accountId !== account.accountId ||
      pending.facts.negotiationId !== body.negotiationId ||
      pending.facts.installationId !== body.installationId ||
      pending.facts.deviceId !== body.deviceId
    ) {
      throw authenticationFailed();
    }

    const device = store.getDevice(body.deviceId);
    if (device === undefined || device.installationId !== body.installationId) {
      throw authenticationFailed();
    }
    if (device.revokedAt !== null) throw pairingRequired();
    // 挑战签发后设备被重配对/换钥：旧挑战立即失效，必须重新申请挑战。
    if (
      device.publicKey !== pending.publicKey ||
      device.pairingGeneration !== pending.pairingGeneration
    ) {
      throw authenticationFailed();
    }

    const canonicalFacts = canonicalize(pending.facts);
    if (canonicalFacts === undefined) {
      throw new GatewayError("INTERNAL_ERROR", "Challenge facts are not JSON serializable");
    }
    const preimage = Buffer.concat([
      Buffer.from(DEVICE_SESSION_SIGNATURE_DOMAIN, "utf8"),
      Buffer.from(canonicalFacts, "utf8"),
    ]);
    if (!verifyEd25519Signature(device.publicKey, preimage, body.signature)) {
      throw authenticationFailed("Invalid device session signature");
    }

    // 验签成功后才消费，签名失败不会让手机端白白重新申请挑战。
    this.#challenges.delete(body.challenge);
    this.#options.logger?.info(
      `[dsh-android-gateway] 设备密钥会话已建立 account=${account.accountId} device=${device.deviceId}`,
    );
    return { accountId: account.accountId, device };
  }

  #resolveAccount(body: { readonly accountId?: string; readonly username?: string }) {
    const account =
      body.accountId !== undefined
        ? this.#options.accounts.findAccount(body.accountId)
        : this.#options.accounts.findAccountByUsername(body.username ?? "");
    if (account === undefined) {
      // 账号不存在与账号存在但设备不匹配返回同一个码，避免账号探测。
      throw authenticationFailed();
    }
    return account;
  }

  #pruneChallenges(now: number): void {
    for (const [challenge, pending] of this.#challenges) {
      if (pending.expiresAt <= now) this.#challenges.delete(challenge);
    }
    while (this.#challenges.size >= MAX_PENDING_CHALLENGES) {
      const oldest = this.#challenges.keys().next().value;
      if (oldest === undefined) break;
      this.#challenges.delete(oldest);
    }
  }
}
