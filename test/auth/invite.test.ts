import { statSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_ACTIVE_INVITES,
  PAIRING_SIGNATURE_DOMAIN,
  PairingInviteService,
  type PairingInviteCreated,
} from "../../src/core/pairing-invites.js";
import type { JsonObject } from "../../src/shared/types.js";
import {
  assertSessionData,
  canonicalJson,
  createDeviceKey,
  createHarness,
  gatewayCodeOf,
  negotiate,
  signBytes,
  type AuthHarness,
  type DeviceKey,
} from "./helpers.js";

const INSTALLATION = "install_invite";
const NEGOTIATION = "neg_invite";
const DOMAIN = "OPEN_ANDROID_INTELLIGENCE_PAIRING_V1\n";

/** 挑战事实的精确字段集合；App 会用集合相等来校验。 */
const FACT_KEYS = [
  "accountId",
  "challengeId",
  "devicePublicKey",
  "expiresAt",
  "installationId",
  "negotiationId",
  "nonce",
] as const;

describe("邀请配对（契约 §5.3）", () => {
  let harness: AuthHarness;
  let invites: PairingInviteService;
  let key: DeviceKey;

  const installation = (): { installationId: string; displayName: string; devicePublicKey: string } => ({
    installationId: INSTALLATION,
    displayName: "Pixel Invite",
    devicePublicKey: key.devicePublicKey,
  });

  const createInvite = (ttlSeconds = 300): PairingInviteCreated =>
    invites.create(harness.aliceId, {
      ttlSeconds,
      gatewayIdentity: {
        deploymentId: harness.accounts.deploymentId(),
        tlsSpkiSha256: null,
      },
    });

  const challenge = async (
    created: PairingInviteCreated,
    overrides: JsonObject = {},
  ): Promise<Record<string, string>> => {
    const result = await harness.auth.inviteChallenge({
      accountId: harness.aliceId,
      negotiationId: NEGOTIATION,
      code: created.code,
      installation: installation(),
      ...overrides,
    });
    return result.data as Record<string, string>;
  };

  const signatureFor = (
    facts: Record<string, string>,
    privateKey = key.privateKey,
  ): string => signBytes(privateKey, `${DOMAIN}${canonicalJson(facts)}`);

  const exchangeBody = (
    facts: Record<string, string>,
    signature: string,
    accountId = harness.aliceId,
  ): JsonObject => ({
    accountId,
    negotiationId: facts.negotiationId as string,
    challengeId: facts.challengeId as string,
    signature,
  });

  beforeEach(async () => {
    harness = await createHarness();
    key = createDeviceKey();
    invites = new PairingInviteService({
      accounts: harness.accounts,
      negotiations: harness.negotiations,
      gatewayUrl: "http://127.0.0.1:43535",
      now: () => harness.clock.now,
    });
    negotiate(harness, { negotiationId: NEGOTIATION, installationId: INSTALLATION });
  });

  afterEach(() => {
    harness.close();
  });

  it("签名域串与 App 逐字节一致", () => {
    expect(PAIRING_SIGNATURE_DOMAIN).toBe(DOMAIN);
  });

  it("创建邀请：短码、深链、0600 原子文件且只保存摘要", () => {
    const created = createInvite();
    expect(created.code).toMatch(/^[A-F0-9]{16}$/);
    expect(created.invitationId).toMatch(/^invite_[A-Za-z0-9._~-]+$/);
    expect(created.expiresAt).toBe("2026-10-20T12:05:00.000Z");

    const uri = new URL(created.uri);
    expect(uri.protocol).toBe("oai:");
    expect(uri.host).toBe("pair");
    expect(uri.searchParams.get("gateway")).toBe("http://127.0.0.1:43535");
    expect(uri.searchParams.get("account")).toBe(harness.aliceId);
    expect(uri.searchParams.get("invitationId")).toBe(created.invitationId);
    expect(uri.searchParams.get("code")).toBe(created.code);
    expect(uri.searchParams.get("expiresAt")).toBe(created.expiresAt);
    expect(uri.searchParams.get("identityFingerprint")).toMatch(/^sha256:[0-9a-f]{64}$/);

    const path = invites.invitesPath(harness.aliceId);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const stored = invites.list(harness.aliceId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.invitationId).toBe(created.invitationId);
    expect(stored[0]?.status).toBe("active");
    expect(stored[0]?.usedAt).toBeUndefined();
    // 落盘只允许摘要，明文短码不能出现在记录字段里。
    expect(JSON.stringify(stored)).not.toContain(`"code"`);
  });

  it("挑战事实恰好 7 字段、scope 正确且 TTL 不超过 60 秒", async () => {
    const created = createInvite();
    const facts = await challenge(created);
    expect(Object.keys(facts).sort()).toEqual([...FACT_KEYS]);
    expect(facts.accountId).toBe(harness.aliceId);
    expect(facts.negotiationId).toBe(NEGOTIATION);
    expect(facts.installationId).toBe(INSTALLATION);
    expect(facts.devicePublicKey).toBe(key.devicePublicKey);
    expect(facts.challengeId).toMatch(/^challenge_/);
    expect(facts.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(facts.expiresAt as string)).toBe(harness.clock.now + 60_000);
    expect(Date.parse(facts.expiresAt as string)).toBeLessThanOrEqual(Date.parse(created.expiresAt));
  });

  it("挑战事实的 JCS 规范化与 App 的 Json.canonical 一致", async () => {
    const facts = await challenge(createInvite());
    // 手工按 RFC 8785 键序拼装，锁定逐字节预像，而不是用同一库自证。
    const expected = JSON.stringify({
      accountId: facts.accountId,
      challengeId: facts.challengeId,
      devicePublicKey: facts.devicePublicKey,
      expiresAt: facts.expiresAt,
      installationId: facts.installationId,
      negotiationId: facts.negotiationId,
      nonce: facts.nonce,
    });
    expect(canonicalJson(facts)).toBe(expected);
    expect(`${DOMAIN}${canonicalJson(facts)}`).toBe(`${DOMAIN}${expected}`);
  });

  it("成功兑换：签发与密码登录一致的会话并绑定设备", async () => {
    const created = createInvite();
    const facts = await challenge(created);
    const login = await harness.auth.loginWithInvite(exchangeBody(facts, signatureFor(facts)));

    expect(login.accountId).toBe(harness.aliceId);
    assertSessionData(login.data);
    expect(login.data.accountId).toBe(harness.aliceId);
    expect(String(login.data.accessToken).length).toBeGreaterThan(20);
    expect(String(login.data.refreshCredential).length).toBeGreaterThan(20);
    expect(login.data.pairingSummary).toBe("Pixel Invite");
    expect(login.data.grantRevision).toBe(1);

    const store = harness.accounts.openStore(harness.aliceId);
    expect(store).toBeDefined();
    const device = store
      ?.listDevices()
      .find((entry) => entry.publicKey === key.devicePublicKey && entry.revokedAt === null);
    expect(device?.deviceId).toBe(login.data.deviceId);
    expect(device?.installationId).toBe(INSTALLATION);
    expect(device?.displayName).toBe("Pixel Invite");

    const stored = invites.list(harness.aliceId);
    expect(stored[0]?.status).toBe("used");
    expect(stored[0]?.usedAt).toBe(new Date(harness.clock.now).toISOString());
  });

  it("邀请一次性：兑换后再用同一短码申请挑战会失败", async () => {
    const created = createInvite();
    const facts = await challenge(created);
    await harness.auth.loginWithInvite(exchangeBody(facts, signatureFor(facts)));

    await expect(
      harness.auth.inviteChallenge({
        accountId: harness.aliceId,
        negotiationId: NEGOTIATION,
        code: created.code,
        installation: installation(),
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("兑换后的挑战重放失败", async () => {
    const facts = await challenge(createInvite());
    const body = exchangeBody(facts, signatureFor(facts));
    await harness.auth.loginWithInvite(body);
    await expect(harness.auth.loginWithInvite(body)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("错误短码：AUTHENTICATION_FAILED（不泄露邀请是否存在）", async () => {
    createInvite();
    await expect(
      harness.auth.inviteChallenge({
        accountId: harness.aliceId,
        negotiationId: NEGOTIATION,
        code: "FFFFFFFFFFFFFFFF",
        installation: installation(),
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("邀请过期：PAIRING_INVITATION_EXPIRED", async () => {
    const created = createInvite(30);
    harness.clock.advance(31_000);
    await expect(challenge(created)).rejects.toMatchObject({
      code: "PAIRING_INVITATION_EXPIRED",
    });
  });

  it("挑战过期但邀请未过期：失败后允许重新申请挑战并完成兑换", async () => {
    const created = createInvite(300);
    const staleFacts = await challenge(created);
    harness.clock.advance(61_000);
    await expect(
      harness.auth.loginWithInvite(exchangeBody(staleFacts, signatureFor(staleFacts))),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });

    const freshFacts = await challenge(created);
    const login = await harness.auth.loginWithInvite(
      exchangeBody(freshFacts, signatureFor(freshFacts)),
    );
    expect(login.data.accountId).toBe(harness.aliceId);
  });

  it("签名错误：失败且不消费挑战，正确签名仍可兑换", async () => {
    const facts = await challenge(createInvite());
    const otherKey = createDeviceKey();
    await expect(
      harness.auth.loginWithInvite(exchangeBody(facts, signatureFor(facts, otherKey.privateKey))),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });

    const login = await harness.auth.loginWithInvite(exchangeBody(facts, signatureFor(facts)));
    expect(login.accountId).toBe(harness.aliceId);
  });

  it("签名覆盖全部事实：只改 challengeId 的签名会被拒绝", async () => {
    const facts = await challenge(createInvite());
    const tampered = { ...facts, challengeId: `${facts.challengeId}tampered` };
    await expect(
      harness.auth.loginWithInvite(exchangeBody(facts, signatureFor(tampered))),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("账号不匹配：用另一个账号兑换失败", async () => {
    const facts = await challenge(createInvite());
    await expect(
      harness.auth.loginWithInvite(exchangeBody(facts, signatureFor(facts), harness.bobId)),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("协商与安装不匹配：PROTOCOL_INCOMPATIBLE", async () => {
    negotiate(harness, { negotiationId: "neg_other_install", installationId: "install_other" });
    const created = createInvite();
    await expect(
      harness.auth.inviteChallenge({
        accountId: harness.aliceId,
        negotiationId: "neg_other_install",
        code: created.code,
        installation: installation(),
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL_INCOMPATIBLE" });
  });

  it("安装不匹配：拒绝把邀请绑定到未协商的安装", async () => {
    const created = createInvite();
    await expect(
      harness.auth.inviteChallenge({
        accountId: harness.aliceId,
        negotiationId: NEGOTIATION,
        code: created.code,
        installation: { ...installation(), installationId: "install_other" },
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL_INCOMPATIBLE" });
  });

  it("撤销邀请后立即失效，重复撤销返回 false", async () => {
    const created = createInvite();
    expect(invites.revoke(harness.aliceId, created.invitationId)).toBe(true);
    expect(invites.revoke(harness.aliceId, created.invitationId)).toBe(false);
    expect(invites.list(harness.aliceId)[0]?.status).toBe("used");
    await expect(challenge(created)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("请求体多余字段：SCHEMA_INVALID", async () => {
    const created = createInvite();
    await expect(
      harness.auth.inviteChallenge({
        accountId: harness.aliceId,
        negotiationId: NEGOTIATION,
        code: created.code,
        installation: installation(),
        extra: true,
      }),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });

    const facts = await challenge(created);
    await expect(
      harness.auth.loginWithInvite({ ...exchangeBody(facts, signatureFor(facts)), extra: 1 }),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it(`同一账号最多 ${MAX_ACTIVE_INVITES} 条活跃邀请`, () => {
    for (let index = 0; index < MAX_ACTIVE_INVITES; index += 1) {
      createInvite(60);
    }
    expect(gatewayCodeOf(() => createInvite(60))).toBe("RATE_LIMITED");
    // 过期邀请不再占用额度。
    harness.clock.advance(61_000);
    expect(() => createInvite(60)).not.toThrow();
  });
});
