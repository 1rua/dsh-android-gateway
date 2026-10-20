import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import canonicalize from "canonicalize";

import { CORE_SCHEMA_HASH } from "../../src/protocol/index.js";
import { AccountManager } from "../../src/core/accounts.js";
import { AuthService } from "../../src/core/auth-service.js";
import { NegotiationManager } from "../../src/core/negotiation.js";
import type { JsonObject } from "../../src/shared/types.js";
import { removeTempDir } from "../store/helpers.js";

/** 测试时钟：所有服务共享同一个可推进的 `now`，便于精确验证 60s/300s 边界。 */
export interface TestClock {
  now: number;
  advance(milliseconds: number): void;
}

export interface DeviceKey {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly devicePublicKey: string;
}

export interface AuthHarness {
  readonly root: string;
  readonly accounts: AccountManager;
  readonly negotiations: NegotiationManager;
  readonly auth: AuthService;
  readonly clock: TestClock;
  readonly aliceId: string;
  readonly bobId: string;
  close(): void;
}

export const TEST_NOW = Date.parse("2026-10-20T12:00:00.000Z");

/** 生成与 Android App 相同编码的 Ed25519 公钥：canonical unpadded base64url 32 字节。 */
export const createDeviceKey = (): DeviceKey => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string") throw new Error("Ed25519 JWK 缺少 x");
  return { privateKey, publicKey, devicePublicKey: jwk.x };
};

/** 对业务预像签名（Ed25519），返回 App 同款 base64url 无填充签名。 */
export const signBytes = (privateKey: KeyObject, preimage: string): string =>
  sign(null, Buffer.from(preimage, "utf8"), privateKey).toString("base64url");

/** 用 RFC 8785 (JCS) 规范化事实对象。 */
export const canonicalJson = (value: unknown): string => {
  const canonical = canonicalize(value);
  if (canonical === undefined) throw new Error("无法规范化 JSON");
  return canonical;
};

export const createHarness = async (): Promise<AuthHarness> => {
  const root = mkdtempSync(join(tmpdir(), "dsh-auth-test-"));
  const clock: TestClock = {
    now: TEST_NOW,
    advance(milliseconds) {
      this.now += milliseconds;
    },
  };
  const accounts = new AccountManager({
    rootDir: root,
    configuredAccounts: [
      { username: "alice", password: "alice-password" },
      { username: "bob", password: "bob-password" },
    ],
  });
  await accounts.initialize();
  const negotiations = new NegotiationManager({
    deploymentId: () => accounts.deploymentId(),
    limits: {
      attachmentTtlSeconds: 3600,
      eventRetentionSeconds: 86_400,
      maxClockSkewSeconds: 120,
    },
    tlsSpkiSha256: null,
    now: () => clock.now,
  });
  const auth = new AuthService({ accounts, negotiations, now: () => clock.now });
  const alice = accounts.findAccountByUsername("alice");
  const bob = accounts.findAccountByUsername("bob");
  if (alice === undefined || bob === undefined) throw new Error("测试账号初始化失败");
  return {
    root,
    accounts,
    negotiations,
    auth,
    clock,
    aliceId: alice.accountId,
    bobId: bob.accountId,
    close() {
      accounts.close();
      removeTempDir(root);
    },
  };
};

/** 按契约 §4 构造一次合法协商；声明全部四种 auth 方法。 */
export const negotiate = (
  harness: Pick<AuthHarness, "negotiations">,
  input: { readonly negotiationId: string; readonly installationId: string },
): void => {
  const request = {
    negotiationId: input.negotiationId,
    protocol: { major: 2, minor: 1 },
    client: {
      installationId: input.installationId,
      appVersion: "2.1.0",
      platform: "android",
      platformApi: 35,
    },
    features: {
      auth: ["password", "account-invitation", "refresh", "device-key"],
      messages: ["chat-v1"],
      attachments: ["staged-sha256-v1"],
      events: ["sse-cursor-v1"],
      deviceRequests: ["risk-queue-v1"],
      conversationUi: ["agent-command-catalog-v1"],
    },
    schemaHashes: { core: CORE_SCHEMA_HASH },
  } as unknown as JsonObject;
  const result = harness.negotiations.negotiate(request, input.negotiationId);
  if (Object.keys(result.data).length === 0) throw new Error("协商失败");
};

/** 登录响应（SessionBundle）的字段闭集，密码/邀请/设备密钥三种登录必须完全一致。 */
export const SESSION_DATA_KEYS = [
  "accessToken",
  "accountId",
  "deviceId",
  "expiresAt",
  "grantRevision",
  "pairingGeneration",
  "pairingSummary",
  "refreshCredential",
  "sessionId",
] as const;

export const assertSessionData = (data: JsonObject): void => {
  if (Object.keys(data).sort().join(",") !== [...SESSION_DATA_KEYS].sort().join(",")) {
    throw new Error(`会话字段不一致: ${Object.keys(data).sort().join(",")}`);
  }
};

/** 同步调用期望抛 GatewayError，并取出错误码；未抛错时返回 undefined。 */
export const gatewayCodeOf = (task: () => unknown): string | undefined => {
  try {
    task();
    return undefined;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
};
