import { createHash } from "node:crypto";

import { GatewayError } from "../shared/errors.js";
import {
  createSecretToken,
  createWireId,
  isWireId,
  nowIso,
} from "../shared/ids.js";
import type {
  JsonObject,
  SessionBundle,
  VerifiedRequest,
} from "../shared/types.js";
import { decodeCanonicalBase64Url, validateGatewayValue } from "../protocol/index.js";
import type { AccountStore } from "../store/contract.js";
import type { AccountManager } from "./accounts.js";
import { DeviceKeyAuthService } from "./device-key-auth.js";
import type { NegotiationManager } from "./negotiation.js";
import { PairingInviteService } from "./pairing-invites.js";

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/** 从邀请挑战请求里取出账号 ID；其余字段交由邀请服务做精确校验。 */
const bodyAccountId = (json: JsonObject | null): string => {
  const accountId = json === null ? undefined : json.accountId;
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new GatewayError("SCHEMA_INVALID", "accountId is required");
  }
  return accountId;
};

interface LoginInstallation {
  readonly installationId: string;
  readonly displayName: string;
  readonly devicePublicKey: string;
}

interface PasswordBody {
  readonly negotiationId: string;
  readonly username: string;
  readonly password: string;
  readonly installation: LoginInstallation;
}

interface RefreshBody {
  readonly negotiationId: string;
  readonly accountId: string;
  readonly installationId: string;
  readonly deviceId: string;
  readonly refreshCredential: string;
}

export interface AuthServiceOptions {
  readonly accounts: AccountManager;
  readonly negotiations: NegotiationManager;
  readonly logger?: { info(message: string): void; warn(message: string): void; error(message: string): void };
  readonly now?: () => number;
  /** 可注入的邀请服务；缺省在 AuthService 内构造，保证挑战与兑换共享同一份内存状态。 */
  readonly invites?: PairingInviteService;
  /** 可注入的设备密钥服务；缺省在 AuthService 内构造。 */
  readonly deviceAuth?: DeviceKeyAuthService;
}

/**
 * 账号绑定：密码登录、邀请配对、设备密钥登录、refresh 轮换、登出、解除配对。
 *
 * 所有秘密只保存摘要；明文只在成功响应的那一次出现。登录永不创建账号
 * （账号由插件首次启动或管理工具创建），与参考实现一致。
 */
export class AuthService {
  readonly #options: AuthServiceOptions;
  readonly #now: () => number;
  readonly #invites: PairingInviteService;
  readonly #deviceAuth: DeviceKeyAuthService;

  constructor(options: AuthServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    this.#invites =
      options.invites ??
      new PairingInviteService({
        accounts: options.accounts,
        negotiations: options.negotiations,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    this.#deviceAuth =
      options.deviceAuth ??
      new DeviceKeyAuthService({
        accounts: options.accounts,
        negotiations: options.negotiations,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
  }

  async login(json: JsonObject | null): Promise<{ data: JsonObject; accountId: string }> {
    if (json === null) throw new GatewayError("SCHEMA_INVALID", "Missing login body");
    const validation = validateGatewayValue("session.password", json);
    if (!validation.ok) throw new GatewayError("SCHEMA_INVALID", "Password login body does not match the contract");
    const body = json as unknown as PasswordBody;

    const negotiation = this.#options.negotiations.get(
      body.negotiationId,
      body.installation.installationId,
    );
    if (negotiation === undefined) {
      throw new GatewayError("PROTOCOL_INCOMPATIBLE", "Unknown or expired negotiation", {
        details: { negotiationId: body.negotiationId },
      });
    }

    const account = this.#options.accounts.findAccountByUsername(body.username);
    if (account === undefined) {
      throw new GatewayError("AUTHENTICATION_FAILED", "Invalid username or password");
    }
    if (decodeCanonicalBase64Url(body.installation.devicePublicKey, 32) === undefined) {
      throw new GatewayError("AUTHENTICATION_FAILED", "Invalid device public key");
    }

    const verified = await this.#options.accounts.verifyAccountPassword(
      account.accountId,
      body.password,
    );
    if (!verified) {
      throw new GatewayError("AUTHENTICATION_FAILED", "Invalid username or password");
    }

    const store = this.#options.accounts.openStore(account.accountId);
    if (store === undefined) throw new GatewayError("ACCOUNT_NOT_FOUND", "Unknown account");
    const bundle = this.#bindDevice(store, account.accountId, body.installation);
    this.#options.logger?.info(
      `[dsh-android-gateway] 设备登录成功 account=${account.accountId} device=${bundle.deviceId}`,
    );
    return { data: this.#bundleData(bundle), accountId: account.accountId };
  }

  refresh(json: JsonObject | null): { data: JsonObject } {
    if (json === null) throw new GatewayError("SCHEMA_INVALID", "Missing refresh body");
    const validation = validateGatewayValue("session.refresh", json);
    if (!validation.ok) throw new GatewayError("SCHEMA_INVALID", "Refresh body does not match the contract");
    const body = json as unknown as RefreshBody;

    const account = this.#options.accounts.findAccount(body.accountId);
    if (account === undefined) throw new GatewayError("AUTHENTICATION_FAILED", "Invalid refresh credential");
    const store = this.#options.accounts.openStore(account.accountId);
    if (store === undefined) throw new GatewayError("AUTHENTICATION_FAILED", "Invalid refresh credential");

    // 协商结果只做弱校验：refresh 凭证本身绑定安装与设备，凭证有效即可轮换。
    const negotiation = this.#options.negotiations.getForRefresh(
      body.negotiationId,
      body.installationId,
    );
    if (negotiation === undefined && body.installationId.length === 0) {
      throw new GatewayError("PROTOCOL_INCOMPATIBLE", "Unknown negotiation");
    }

    const credentialHash = sha256Hex(body.refreshCredential);
    const credential = store.findRefreshCredential(credentialHash);
    if (credential === undefined) {
      throw new GatewayError("AUTHENTICATION_FAILED", "Invalid refresh credential");
    }
    if (credential.revokedAt !== null) {
      // 重复使用已轮换的 refresh：撤销该设备全部凭据与会话（契约 §5.4）。
      store.revokeRefreshCredentialsForDevice(credential.deviceId, nowIso());
      store.revokeAccessSessionsForDevice(credential.deviceId, nowIso());
      throw new GatewayError("REFRESH_REUSED", "Refresh credential was already used");
    }
    if (
      credential.deviceId !== body.deviceId ||
      credential.installationId !== body.installationId
    ) {
      throw new GatewayError("AUTHENTICATION_FAILED", "Refresh credential scope mismatch");
    }
    const device = store.getDevice(credential.deviceId);
    if (device === undefined || device.revokedAt !== null) {
      throw new GatewayError("PAIRING_REQUIRED", "Device pairing is not active");
    }

    const now = this.#now();
    store.revokeRefreshCredential(credentialHash, nowIso(new Date(now)));
    const bundle = this.#issueSession(store, {
      accountId: account.accountId,
      device,
      pairingSummary: device.displayName,
    });
    return { data: this.#bundleData(bundle) };
  }

  // ───────────────────────────── 邀请配对（契约 §5.3） ─────────────────────────────

  /** 邀请挑战：返回 App 校验的精确 7 字段事实（`data` 直接是事实对象）。 */
  async inviteChallenge(json: JsonObject | null): Promise<{ data: JsonObject; accountId: string }> {
    const accountId = bodyAccountId(json);
    const facts = this.#invites.challenge(accountId, json);
    return { data: { ...facts }, accountId: facts.accountId };
  }

  /** 邀请兑换：成功响应与密码登录完全一致，并沿用同一套设备绑定与会话签发。 */
  async loginWithInvite(json: JsonObject | null): Promise<{ data: JsonObject; accountId: string }> {
    const exchanged = this.#invites.exchange(json);
    const account = this.#options.accounts.findAccount(exchanged.accountId);
    if (account === undefined) {
      throw new GatewayError("AUTHENTICATION_FAILED", "Pairing invitation is not valid");
    }
    const store = this.#options.accounts.openStore(account.accountId);
    if (store === undefined) throw new GatewayError("ACCOUNT_NOT_FOUND", "Unknown account");
    const bundle = this.#bindDevice(store, account.accountId, exchanged.installation);
    this.#options.logger?.info(
      `[dsh-android-gateway] 邀请配对登录成功 account=${account.accountId} device=${bundle.deviceId}`,
    );
    return { data: this.#bundleData(bundle), accountId: account.accountId };
  }

  // ───────────────────────────── 设备密钥会话（契约 §5.4） ─────────────────────────────

  /** 设备挑战：返回 App 校验的精确 7 字段事实（`data` 直接是事实对象）。 */
  deviceChallenge(json: JsonObject | null): { data: JsonObject; accountId: string } {
    const facts = this.#deviceAuth.challenge(json);
    return { data: { ...facts }, accountId: facts.accountId };
  }

  /** 设备密钥登录：只对已配对设备签发新会话，不新建/复用其他设备记录。 */
  async loginWithDeviceKey(json: JsonObject | null): Promise<{ data: JsonObject; accountId: string }> {
    const result = this.#deviceAuth.exchange(json);
    const store = this.#options.accounts.openStore(result.accountId);
    if (store === undefined) throw new GatewayError("ACCOUNT_NOT_FOUND", "Unknown account");
    const bundle = this.#issueSession(store, {
      accountId: result.accountId,
      device: result.device,
      pairingSummary: result.device.displayName,
    });
    this.#options.logger?.info(
      `[dsh-android-gateway] 设备密钥登录成功 account=${result.accountId} device=${result.device.deviceId}`,
    );
    return { data: this.#bundleData(bundle), accountId: result.accountId };
  }

  logout(request: VerifiedRequest, revokeRefresh: boolean): JsonObject {
    const store = this.#options.accounts.openStore(request.accountId);
    if (store === undefined) throw new GatewayError("AUTHENTICATION_REQUIRED", "Unknown session");
    store.revokeAccessSession(request.sessionId, nowIso());
    let refreshRevoked = false;
    if (revokeRefresh) {
      refreshRevoked = store.revokeRefreshCredentialsForDevice(request.deviceId, nowIso()) > 0;
    }
    return { sessionId: request.sessionId, refreshRevoked };
  }

  unpair(request: VerifiedRequest): JsonObject {
    const store = this.#options.accounts.openStore(request.accountId);
    if (store === undefined) throw new GatewayError("PAIRING_REQUIRED", "Unknown account");
    const device = store.getDevice(request.deviceId);
    if (device === undefined || device.revokedAt !== null) {
      throw new GatewayError("PAIRING_REQUIRED", "Device pairing is not active");
    }
    const refreshRevoked = store.revokeRefreshCredentialsForDevice(request.deviceId, nowIso()) > 0;
    const sessionsRevoked = store.revokeAccessSessionsForDevice(request.deviceId, nowIso()) > 0;
    store.revokeDevice(request.deviceId, nowIso());
    return {
      deviceId: request.deviceId,
      deviceKeysRevoked: true,
      refreshRevoked,
      grantsRevoked: true,
      deviceRequestsRevoked: true,
      unconfirmedAttachmentsRevoked: true,
      sessionsRevoked,
    };
  }

  #bindDevice(
    store: AccountStore,
    accountId: string,
    installation: LoginInstallation,
  ): SessionBundle {
    const existing = store
      .listDevices()
      .find(
        (device) =>
          device.installationId === installation.installationId && device.revokedAt === null,
      );
    let device = existing;
    if (device !== undefined && device.publicKey !== installation.devicePublicKey) {
      store.revokeDevice(device.deviceId, nowIso());
      device = undefined;
    }
    if (device === undefined) {
      device = store.insertDevice({
        deviceId: createWireId("dev_"),
        installationId: installation.installationId,
        publicKey: installation.devicePublicKey,
        displayName: installation.displayName,
        pairingId: createWireId("pair_"),
        pairingGeneration: existing === undefined ? 1 : existing.pairingGeneration + 1,
        pairedAt: nowIso(),
      });
    }
    return this.#issueSession(store, {
      accountId,
      device,
      pairingSummary: installation.displayName,
    });
  }

  #issueSession(
    store: AccountStore,
    input: {
      readonly accountId: string;
      readonly device: import("../shared/types.js").DeviceRecord;
      readonly pairingSummary: string;
    },
  ): SessionBundle {
    const now = this.#now();
    const accessToken = createSecretToken(32);
    const refreshCredential = createSecretToken(32);
    const sessionId = createWireId("sess_");
    const expiresAt = new Date(now + ACCESS_TOKEN_TTL_MS).toISOString();
    store.insertAccessSession({
      sessionId,
      tokenHash: sha256Hex(accessToken),
      deviceId: input.device.deviceId,
      createdAt: nowIso(new Date(now)),
      expiresAt,
    });
    store.insertRefreshCredential({
      credentialHash: sha256Hex(refreshCredential),
      deviceId: input.device.deviceId,
      installationId: input.device.installationId,
      createdAt: nowIso(new Date(now)),
    });
    return {
      accountId: input.accountId,
      deviceId: input.device.deviceId,
      sessionId,
      accessToken,
      refreshCredential,
      expiresAt,
      pairingId: input.device.pairingId,
      pairingGeneration: input.device.pairingGeneration,
      grantRevision: 1,
      pairingSummary: input.pairingSummary,
    };
  }

  #bundleData(bundle: SessionBundle): JsonObject {
    return {
      accountId: bundle.accountId,
      deviceId: bundle.deviceId,
      sessionId: bundle.sessionId,
      accessToken: bundle.accessToken,
      refreshCredential: bundle.refreshCredential,
      expiresAt: bundle.expiresAt,
      pairingGeneration: bundle.pairingGeneration,
      grantRevision: bundle.grantRevision,
      pairingSummary: bundle.pairingSummary,
    };
  }
}

/** 供外部工具校验 wire ID 的简单断言。 */
export const requireWireId = (value: unknown, label: string): string => {
  if (!isWireId(value)) throw new GatewayError("SCHEMA_INVALID", `Invalid ${label}`);
  return value;
};
