import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import canonicalize from "canonicalize";

import { decodeCanonicalBase64Url, verifyEd25519Signature } from "../protocol/index.js";
import { GatewayError } from "../shared/errors.js";
import { createWireId, isWireId, nowIso } from "../shared/ids.js";
import type { JsonObject } from "../shared/types.js";
import type { AccountManager } from "./accounts.js";
import type { NegotiationManager } from "./negotiation.js";

/** 邀请签名的域分隔串；必须与 App 的 `GatewayAuthClient.loginWithInvite` 逐字节一致。 */
export const PAIRING_SIGNATURE_DOMAIN = "OPEN_ANDROID_INTELLIGENCE_PAIRING_V1\n";

/** 邀请文件版本；未来破坏性变更时递增并做迁移。 */
const INVITES_VERSION = 1;
/** 默认邀请有效期（秒），契约 §5.3 的「默认 5 分钟」。 */
export const DEFAULT_INVITE_TTL_SECONDS = 300;
const MIN_INVITE_TTL_SECONDS = 30;
const MAX_INVITE_TTL_SECONDS = 900;
/** 单账号同时存活的邀请上限；超出后拒绝创建新的邀请。 */
export const MAX_ACTIVE_INVITES = 128;
/** 挑战有效期：60 秒，且不超过邀请自身的过期时刻。 */
const CHALLENGE_TTL_MS = 60_000;
/** 进程内未兑换挑战上限，防止持有有效邀请码的客户端无限堆积内存。 */
const MAX_PENDING_CHALLENGES = 512;
const CODE_PATTERN = /^[A-F0-9]{16}$/;

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIsoMillis = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value);

/** 常量时间比较两个十六进制摘要，避免按字节泄漏邀请码是否存在。 */
const secretsEqual = (left: string, right: string): boolean => {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  try {
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  } catch {
    return false;
  }
};

const schemaInvalid = (message: string): GatewayError => new GatewayError("SCHEMA_INVALID", message);

const authenticationFailed = (message = "Pairing invitation is not valid"): GatewayError =>
  new GatewayError("AUTHENTICATION_FAILED", message);

/** 拒绝契约未声明的多余字段，避免把拼写错误当成默认值悄悄接受。 */
const rejectUnknownFields = (
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw schemaInvalid(`${label} has unknown field: ${key}`);
  }
};

export interface PairingInstallation {
  readonly installationId: string;
  readonly displayName: string;
  readonly devicePublicKey: string;
}

/** `invites.json` 中的一条邀请记录；只保存短码摘要，明文短码从不落盘。 */
export interface PairingInviteRecord {
  readonly invitationId: string;
  /** `sha256(code)` 的小写十六进制；邀请码本身只在创建时返回一次。 */
  readonly codeHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** 兑换或撤销的时刻；一旦写入即表示该邀请不可再用。 */
  readonly usedAt?: string;
}

export interface PairingInviteCreateOptions {
  /** 二维码里的 Gateway 地址；缺省使用构造参数或 `DSH_WEB_URL`。 */
  readonly gatewayUrl?: string;
  /** 有效期秒数，默认 300，允许 30–900。 */
  readonly ttlSeconds?: number;
  /** 生成身份指纹的 Gateway 身份对象（通常是协商响应里的 `gatewayIdentity`）。 */
  readonly gatewayIdentity?: JsonObject;
  /** 覆盖当前时间，主要供测试使用。 */
  readonly now?: Date;
}

export interface PairingInviteCreated {
  readonly invitationId: string;
  readonly code: string;
  readonly expiresAt: string;
  /** `oai://pair?...` 深链，可直接粘贴给 App 或编码成二维码。 */
  readonly uri: string;
}

/** 邀请挑战响应 `data` 的精确 7 字段；App 会核对字段集合与 scope。 */
export interface PairingChallengeFacts {
  readonly challengeId: string;
  readonly accountId: string;
  readonly negotiationId: string;
  readonly installationId: string;
  readonly devicePublicKey: string;
  readonly nonce: string;
  readonly expiresAt: string;
}

export interface PairingExchangeResult {
  readonly accountId: string;
  readonly installation: PairingInstallation;
}

export interface PairingInviteView extends PairingInviteRecord {
  readonly status: "active" | "used" | "expired";
}

export interface PairingInviteServiceOptions {
  readonly accounts: AccountManager;
  readonly negotiations: NegotiationManager;
  /** 缺省深链地址；未配置时回退 `DSH_WEB_URL`，再回退本机默认 DSH 端口。 */
  readonly gatewayUrl?: string;
  readonly logger?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  readonly now?: () => number;
}

interface StoredInvites {
  readonly version: 1;
  readonly invites: readonly PairingInviteRecord[];
}

interface PendingChallenge {
  readonly accountId: string;
  readonly facts: PairingChallengeFacts;
  readonly installation: PairingInstallation;
  readonly codeHash: string;
  readonly expiresAt: number;
}

interface InviteChallengeBody {
  readonly accountId: string;
  readonly negotiationId: string;
  readonly code: string;
  readonly installation: PairingInstallation;
}

interface InviteExchangeBody {
  readonly accountId: string;
  readonly negotiationId: string;
  readonly challengeId: string;
  readonly signature: string;
}

/** 深链参数顺序与契约/参考实现保持一致，便于人工核对。 */
const buildPairUri = (input: {
  readonly gatewayUrl: string;
  readonly accountId: string;
  readonly invitationId: string;
  readonly code: string;
  readonly expiresAt: string;
  readonly identityFingerprint: string;
}): string => {
  const params = new URLSearchParams({
    gateway: input.gatewayUrl,
    account: input.accountId,
    invitationId: input.invitationId,
    code: input.code,
    expiresAt: input.expiresAt,
    identityFingerprint: input.identityFingerprint,
  });
  return `oai://pair?${params.toString()}`;
};

/** 只接受无凭据、无 query/hash 的 http(s) 地址；App 不支持路径前缀，这里保留路径但去掉尾斜杠。 */
const normalizeGatewayUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw schemaInvalid("gatewayUrl must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw schemaInvalid("gatewayUrl must use http or https");
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw schemaInvalid("gatewayUrl must not contain credentials, query or fragment");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/u, "");
};

const parseInstallation = (value: unknown): PairingInstallation => {
  if (!isObject(value)) throw schemaInvalid("installation must be an object");
  rejectUnknownFields(value, ["installationId", "displayName", "devicePublicKey"], "installation");
  const installationId = value.installationId;
  const displayName = value.displayName;
  const devicePublicKey = value.devicePublicKey;
  if (!isWireId(installationId)) throw schemaInvalid("installation.installationId must be a wire id");
  if (typeof displayName !== "string" || displayName.length === 0 || displayName.length > 200) {
    throw schemaInvalid("installation.displayName must be a non-empty string of at most 200 characters");
  }
  // 公钥属于认证材料：格式错误按认证失败处理，避免向调用方确认「账号/邀请是否存在」。
  if (typeof devicePublicKey !== "string" || decodeCanonicalBase64Url(devicePublicKey, 32) === undefined) {
    throw authenticationFailed("Invalid device public key");
  }
  return { installationId, displayName, devicePublicKey };
};

const parseChallengeBody = (json: JsonObject | null): InviteChallengeBody => {
  if (!isObject(json)) throw schemaInvalid("Missing invite challenge body");
  rejectUnknownFields(
    json,
    ["accountId", "negotiationId", "code", "installation"],
    "invite challenge",
  );
  const accountId = json.accountId;
  const negotiationId = json.negotiationId;
  const code = json.code;
  if (!isWireId(accountId)) throw schemaInvalid("accountId must be a wire id");
  if (!isWireId(negotiationId)) throw schemaInvalid("negotiationId must be a wire id");
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) {
    throw schemaInvalid("code must be 16 uppercase hexadecimal characters");
  }
  return {
    accountId,
    negotiationId,
    code,
    installation: parseInstallation(json.installation),
  };
};

const parseExchangeBody = (json: JsonObject | null): InviteExchangeBody => {
  if (!isObject(json)) throw schemaInvalid("Missing pairing exchange body");
  rejectUnknownFields(
    json,
    ["accountId", "negotiationId", "challengeId", "signature"],
    "pairing exchange",
  );
  const accountId = json.accountId;
  const negotiationId = json.negotiationId;
  const challengeId = json.challengeId;
  const signature = json.signature;
  if (!isWireId(accountId)) throw schemaInvalid("accountId must be a wire id");
  if (!isWireId(negotiationId)) throw schemaInvalid("negotiationId must be a wire id");
  if (!isWireId(challengeId)) throw schemaInvalid("challengeId must be a wire id");
  if (typeof signature !== "string") throw schemaInvalid("signature must be a string");
  return { accountId, negotiationId, challengeId, signature };
};

const parseStoredInvites = (raw: unknown): readonly PairingInviteRecord[] => {
  if (!isObject(raw) || raw.version !== INVITES_VERSION || !Array.isArray(raw.invites)) {
    throw new Error("INVITES_CORRUPT");
  }
  return raw.invites.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`INVITES_CORRUPT:invites[${index}]`);
    const invitationId = entry.invitationId;
    const codeHash = entry.codeHash;
    const createdAt = entry.createdAt;
    const expiresAt = entry.expiresAt;
    const usedAt = entry.usedAt;
    if (!isWireId(invitationId)) throw new Error(`INVITES_CORRUPT:invites[${index}].invitationId`);
    if (typeof codeHash !== "string" || !/^[0-9a-f]{64}$/.test(codeHash)) {
      throw new Error(`INVITES_CORRUPT:invites[${index}].codeHash`);
    }
    if (!isIsoMillis(createdAt) || !isIsoMillis(expiresAt)) {
      throw new Error(`INVITES_CORRUPT:invites[${index}].time`);
    }
    if (usedAt !== undefined && !isIsoMillis(usedAt)) {
      throw new Error(`INVITES_CORRUPT:invites[${index}].usedAt`);
    }
    return {
      invitationId,
      codeHash,
      createdAt,
      expiresAt,
      ...(usedAt === undefined ? {} : { usedAt }),
    };
  });
};

/**
 * 账号邀请配对（契约 §5.3）。
 *
 * 短码只以 `sha256(code)` 落盘；邀请一次性，兑换成功后写 `usedAt`。
 * 未兑换的挑战只保存在内存中（进程重启后自然失效），并绑定
 * `accountId + negotiationId + installationId + devicePublicKey` 四项 scope。
 *
 * 深链/短码生成完全离线，不依赖网络或 App；二维码由操作员工具把 `uri` 编码。
 */
export class PairingInviteService {
  readonly #options: PairingInviteServiceOptions;
  readonly #now: () => number;
  readonly #defaultGatewayUrl: string;
  readonly #challenges = new Map<string, PendingChallenge>();

  constructor(options: PairingInviteServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    const environmentUrl = process.env.DSH_WEB_URL?.trim();
    this.#defaultGatewayUrl =
      options.gatewayUrl ??
      (environmentUrl === undefined || environmentUrl.length === 0
        ? "http://127.0.0.1:43535"
        : environmentUrl);
  }

  invitesPath(accountId: string): string {
    return join(this.#options.accounts.accountDir(accountId), "invites.json");
  }

  /** 生成一次性邀请短码与 `oai://pair?...` 深链。 */
  create(accountId: string, options: PairingInviteCreateOptions = {}): PairingInviteCreated {
    const account = this.#options.accounts.findAccount(accountId);
    if (account === undefined) throw new GatewayError("ACCOUNT_NOT_FOUND", "Unknown account");

    const now = options.now?.getTime() ?? this.#now();
    const ttlSeconds = options.ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS;
    if (
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < MIN_INVITE_TTL_SECONDS ||
      ttlSeconds > MAX_INVITE_TTL_SECONDS
    ) {
      throw schemaInvalid(
        `Invitation TTL must be an integer between ${MIN_INVITE_TTL_SECONDS} and ${MAX_INVITE_TTL_SECONDS} seconds`,
      );
    }
    const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl ?? this.#defaultGatewayUrl);

    const state = this.#read(accountId);
    const active = state.invites.filter(
      (invite) => invite.usedAt === undefined && Date.parse(invite.expiresAt) > now,
    );
    if (active.length >= MAX_ACTIVE_INVITES) {
      throw new GatewayError("RATE_LIMITED", "Too many active pairing invitations", {
        retryAfterSeconds: 60,
      });
    }

    // 随机 8 字节 → 16 位大写十六进制；极小概率碰撞时重新抽取。
    let code = "";
    let codeHash = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      code = randomBytes(8).toString("hex").toUpperCase();
      codeHash = sha256Hex(code);
      if (!state.invites.some((invite) => invite.codeHash === codeHash)) break;
    }
    if (code === "" || codeHash === "") throw new GatewayError("INTERNAL_ERROR", "Failed to generate invitation code");

    const invitationId = createWireId("invite_");
    const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
    const record: PairingInviteRecord = {
      invitationId,
      codeHash,
      createdAt: nowIso(new Date(now)),
      expiresAt,
    };
    this.#write(accountId, [...state.invites, record]);

    const canonicalIdentity = canonicalize(options.gatewayIdentity ?? {});
    if (canonicalIdentity === undefined) throw schemaInvalid("gatewayIdentity must be JSON serializable");
    const identityFingerprint = `sha256:${sha256Hex(canonicalIdentity)}`;
    const uri = buildPairUri({
      gatewayUrl,
      accountId: account.accountId,
      invitationId,
      code,
      expiresAt,
      identityFingerprint,
    });
    this.#options.logger?.info(
      `[dsh-android-gateway] 已生成配对邀请 account=${account.accountId} invitationId=${invitationId} expiresAt=${expiresAt}`,
    );
    return { invitationId, code, expiresAt, uri };
  }

  /** 列出邀请（含已使用/已过期），只暴露摘要而绝不再返回明文短码。 */
  list(accountId: string): readonly PairingInviteView[] {
    if (this.#options.accounts.findAccount(accountId) === undefined) {
      throw new GatewayError("ACCOUNT_NOT_FOUND", "Unknown account");
    }
    const now = this.#now();
    return this.#read(accountId)
      .invites.map((invite) => ({
        ...invite,
        status:
          invite.usedAt !== undefined
            ? ("used" as const)
            : Date.parse(invite.expiresAt) <= now
              ? ("expired" as const)
              : ("active" as const),
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** 撤销未使用的邀请；返回是否真的改变了状态。 */
  revoke(accountId: string, invitationId: string): boolean {
    if (this.#options.accounts.findAccount(accountId) === undefined) {
      throw new GatewayError("ACCOUNT_NOT_FOUND", "Unknown account");
    }
    if (typeof invitationId !== "string" || invitationId.length === 0) {
      throw schemaInvalid("invitationId must be a non-empty string");
    }
    const state = this.#read(accountId);
    const index = state.invites.findIndex((invite) => invite.invitationId === invitationId);
    if (index < 0) return false;
    const record = state.invites[index];
    if (record === undefined || record.usedAt !== undefined) return false;
    const usedAt = nowIso(new Date(this.#now()));
    const next = state.invites.map((invite, current) =>
      current === index ? { ...invite, usedAt } : invite,
    );
    this.#write(accountId, next);
    // 撤销邀请后，已签发但尚未兑换的挑战也必须立即失效。
    for (const [challengeId, challenge] of this.#challenges) {
      if (challenge.accountId === accountId && secretsEqual(challenge.codeHash, record.codeHash)) {
        this.#challenges.delete(challengeId);
      }
    }
    return true;
  }

  /** 邀请挑战：校验协商绑定、邀请码与安装信息，返回精确 7 字段事实。 */
  challenge(accountId: string, json: JsonObject | null): PairingChallengeFacts {
    const body = parseChallengeBody(json);
    if (body.accountId !== accountId) throw authenticationFailed();

    const account = this.#options.accounts.findAccount(accountId);
    if (account === undefined) throw authenticationFailed();

    // 协商结果必须存在且绑定同一个安装；否则属于协议/安装不匹配。
    const negotiation = this.#options.negotiations.get(body.negotiationId, body.installation.installationId);
    if (negotiation === undefined) {
      throw new GatewayError("PROTOCOL_INCOMPATIBLE", "Unknown or expired negotiation", {
        details: { negotiationId: body.negotiationId },
      });
    }

    const now = this.#now();
    const state = this.#read(accountId);
    const codeHash = sha256Hex(body.code);
    const invite = state.invites.find((record) => secretsEqual(record.codeHash, codeHash));
    if (invite === undefined) throw authenticationFailed();
    if (invite.usedAt !== undefined) throw authenticationFailed();
    if (Date.parse(invite.expiresAt) <= now) {
      throw new GatewayError("PAIRING_INVITATION_EXPIRED", "Pairing invitation has expired");
    }

    const challengeId = createWireId("challenge_");
    const expiresAt = new Date(
      Math.min(now + CHALLENGE_TTL_MS, Date.parse(invite.expiresAt)),
    ).toISOString();
    const facts: PairingChallengeFacts = {
      challengeId,
      accountId: account.accountId,
      negotiationId: body.negotiationId,
      installationId: body.installation.installationId,
      devicePublicKey: body.installation.devicePublicKey,
      nonce: randomBytes(32).toString("base64url"),
      expiresAt,
    };

    this.#pruneChallenges(now);
    this.#challenges.set(challengeId, {
      accountId: account.accountId,
      facts,
      installation: body.installation,
      codeHash,
      expiresAt: Date.parse(expiresAt),
    });
    return facts;
  }

  /**
   * 兑换邀请：校验挑战 scope 与 Ed25519 签名，成功后才一次性消费邀请与挑战。
   * 签名错误、scope 不匹配都不会消耗挑战，允许手机端修正后重试。
   */
  exchange(json: JsonObject | null): PairingExchangeResult {
    const body = parseExchangeBody(json);
    const now = this.#now();
    this.#pruneChallenges(now);

    const pending = this.#challenges.get(body.challengeId);
    if (pending === undefined) throw authenticationFailed();
    if (pending.accountId !== body.accountId || pending.facts.negotiationId !== body.negotiationId) {
      throw authenticationFailed();
    }

    const state = this.#read(body.accountId);
    const invite = state.invites.find((record) => secretsEqual(record.codeHash, pending.codeHash));
    if (invite === undefined || invite.usedAt !== undefined) throw authenticationFailed();
    if (Date.parse(invite.expiresAt) <= now) {
      throw new GatewayError("PAIRING_INVITATION_EXPIRED", "Pairing invitation has expired");
    }
    if (pending.expiresAt <= now) throw authenticationFailed("Pairing challenge has expired");

    const signatureBytes = decodeCanonicalBase64Url(body.signature, 64);
    if (signatureBytes === undefined) throw authenticationFailed("Invalid pairing signature");
    const canonicalFacts = canonicalize(pending.facts);
    if (canonicalFacts === undefined) throw new GatewayError("INTERNAL_ERROR", "Challenge facts are not JSON serializable");
    const preimage = Buffer.concat([
      Buffer.from(PAIRING_SIGNATURE_DOMAIN, "utf8"),
      Buffer.from(canonicalFacts, "utf8"),
    ]);
    if (!verifyEd25519Signature(pending.facts.devicePublicKey, preimage, body.signature)) {
      throw authenticationFailed("Invalid pairing signature");
    }

    // 验签成功后才消费：挑战只可使用一次，邀请写入 usedAt 后永久失效。
    this.#challenges.delete(body.challengeId);
    const usedAt = nowIso(new Date(now));
    const next = state.invites.map((record) =>
      record.invitationId === invite.invitationId ? { ...record, usedAt } : record,
    );
    try {
      this.#write(body.accountId, next);
    } catch (error) {
      throw new GatewayError("INTERNAL_ERROR", "Failed to persist pairing invitation consumption", {
        cause: error,
      });
    }
    this.#options.logger?.info(
      `[dsh-android-gateway] 邀请配对已兑换 account=${body.accountId} invitationId=${invite.invitationId}`,
    );
    return { accountId: pending.accountId, installation: pending.installation };
  }

  #pruneChallenges(now: number): void {
    for (const [challengeId, challenge] of this.#challenges) {
      if (challenge.expiresAt <= now) this.#challenges.delete(challengeId);
    }
    while (this.#challenges.size >= MAX_PENDING_CHALLENGES) {
      const oldest = this.#challenges.keys().next().value;
      if (oldest === undefined) break;
      this.#challenges.delete(oldest);
    }
  }

  #read(accountId: string): StoredInvites {
    const path = this.invitesPath(accountId);
    if (!existsSync(path)) return { version: INVITES_VERSION, invites: [] };
    try {
      return {
        version: INVITES_VERSION,
        invites: parseStoredInvites(JSON.parse(readFileSync(path, "utf8"))),
      };
    } catch (error) {
      // 读不懂的文件按「没有可用邀请」处理：这是失败关闭（fail closed），
      // 不会让损坏的存储意外放行。新邀请写入时会以合法文件覆盖。
      this.#options.logger?.warn(
        `[dsh-android-gateway] 邀请存储损坏，已按空邀请处理 path=${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { version: INVITES_VERSION, invites: [] };
    }
  }

  #write(accountId: string, invites: readonly PairingInviteRecord[]): void {
    const dir = this.#options.accounts.accountDir(accountId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // 非 POSIX 平台尽力而为；文件本身仍以 0600 创建。
    }
    const path = this.invitesPath(accountId);
    const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const payload = `${JSON.stringify({ version: INVITES_VERSION, invites }, null, 2)}\n`;
    try {
      writeFileSync(temp, payload, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
    } catch (error) {
      // 只回收本次原子写产生的自有临时文件，不触碰任何业务文件。
      try {
        unlinkSync(temp);
      } catch {
        // 临时文件可能尚未创建，忽略。
      }
      throw error;
    }
  }
}
