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
import type { NegotiationManager } from "./negotiation.js";

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

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
}

/**
 * 账号绑定：密码登录、refresh 轮换、登出、解除配对。
 *
 * 所有秘密只保存摘要；明文只在成功响应的那一次出现。登录永不创建账号
 * （账号由插件首次启动或管理工具创建），与参考实现一致。
 */
export class AuthService {
  readonly #options: AuthServiceOptions;
  readonly #now: () => number;

  constructor(options: AuthServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
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
