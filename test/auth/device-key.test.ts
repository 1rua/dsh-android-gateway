import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEVICE_SESSION_SIGNATURE_DOMAIN } from "../../src/core/device-key-auth.js";
import { nowIso } from "../../src/shared/ids.js";
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

const INSTALLATION = "install_device";
const NEGOTIATION = "neg_device";
const DOMAIN = "OPEN_ANDROID_INTELLIGENCE_DEVICE_SESSION_V1\n";

const FACT_KEYS = [
  "accountId",
  "challenge",
  "deviceId",
  "expiresAt",
  "installationId",
  "negotiationId",
  "nonce",
] as const;

describe("设备密钥会话（契约 §5.4）", () => {
  let harness: AuthHarness;
  let key: DeviceKey;
  let deviceId: string;

  const challenge = (overrides: JsonObject = {}): Record<string, string> =>
    harness.auth.deviceChallenge({
      accountId: harness.aliceId,
      negotiationId: NEGOTIATION,
      installationId: INSTALLATION,
      deviceId,
      ...overrides,
    }).data as Record<string, string>;

  const signatureFor = (
    facts: Record<string, string>,
    privateKey = key.privateKey,
  ): string => signBytes(privateKey, `${DOMAIN}${canonicalJson(facts)}`);

  const exchangeBody = (
    facts: Record<string, string>,
    signature: string,
    overrides: Record<string, unknown> = {},
  ): JsonObject => {
    const body: Record<string, unknown> = {
      accountId: harness.aliceId,
      negotiationId: facts.negotiationId as string,
      installationId: facts.installationId as string,
      deviceId: facts.deviceId as string,
      challenge: facts.challenge as string,
      signature,
      ...overrides,
    };
    // undefined 用于删除默认字段（例如改用 username 标识账号）。
    for (const field of Object.keys(body)) {
      if (body[field] === undefined) delete body[field];
    }
    return body as JsonObject;
  };

  beforeEach(async () => {
    harness = await createHarness();
    key = createDeviceKey();
    negotiate(harness, { negotiationId: NEGOTIATION, installationId: INSTALLATION });
    // 先用密码登录完成一次真实配对（设备记录是设备密钥登录的前提）。
    const login = await harness.auth.login({
      negotiationId: NEGOTIATION,
      username: "alice",
      password: "alice-password",
      installation: {
        installationId: INSTALLATION,
        displayName: "Pixel Device",
        devicePublicKey: key.devicePublicKey,
      },
    });
    deviceId = login.data.deviceId as string;
    if (typeof deviceId !== "string") throw new Error("密码登录未返回 deviceId");
  });

  afterEach(() => {
    harness.close();
  });

  it("签名域串与 App 逐字节一致", () => {
    expect(DEVICE_SESSION_SIGNATURE_DOMAIN).toBe(DOMAIN);
  });

  it("挑战事实恰好 7 字段、scope 正确且 TTL 为 60 秒", () => {
    const facts = challenge();
    expect(Object.keys(facts).sort()).toEqual([...FACT_KEYS]);
    expect(facts.accountId).toBe(harness.aliceId);
    expect(facts.negotiationId).toBe(NEGOTIATION);
    expect(facts.installationId).toBe(INSTALLATION);
    expect(facts.deviceId).toBe(deviceId);
    expect(facts.challenge).toMatch(/^challenge_/);
    expect(facts.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(facts.expiresAt).toBe("2026-10-20T12:01:00.000Z");
  });

  it("挑战事实的 JCS 规范化与 App 的 Json.canonical 一致", () => {
    const facts = challenge();
    const expected = JSON.stringify({
      accountId: facts.accountId,
      challenge: facts.challenge,
      deviceId: facts.deviceId,
      expiresAt: facts.expiresAt,
      installationId: facts.installationId,
      negotiationId: facts.negotiationId,
      nonce: facts.nonce,
    });
    expect(canonicalJson(facts)).toBe(expected);
  });

  it("成功登录：同一设备签发与密码登录一致的会话", async () => {
    const facts = challenge();
    const login = await harness.auth.loginWithDeviceKey(exchangeBody(facts, signatureFor(facts)));
    expect(login.accountId).toBe(harness.aliceId);
    assertSessionData(login.data);
    expect(login.data.accountId).toBe(harness.aliceId);
    expect(login.data.deviceId).toBe(deviceId);
    expect(login.data.pairingSummary).toBe("Pixel Device");

    // 没有新建第二条设备记录：设备密钥不能隐式重配对。
    const devices = harness.accounts.openStore(harness.aliceId)?.listDevices() ?? [];
    expect(devices.filter((device) => device.revokedAt === null)).toHaveLength(1);
  });

  it("支持 username 形式的账号标识（挑战与兑换都可用）", async () => {
    const facts = harness.auth.deviceChallenge({
      username: "alice",
      negotiationId: NEGOTIATION,
      installationId: INSTALLATION,
      deviceId,
    }).data as Record<string, string>;
    const login = await harness.auth.loginWithDeviceKey(
      exchangeBody(facts, signatureFor(facts), { accountId: undefined, username: "alice" }),
    );
    expect(login.accountId).toBe(harness.aliceId);
  });

  it("挑战重放失败", async () => {
    const facts = challenge();
    const body = exchangeBody(facts, signatureFor(facts));
    await harness.auth.loginWithDeviceKey(body);
    await expect(harness.auth.loginWithDeviceKey(body)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("挑战过期：AUTHENTICATION_FAILED", async () => {
    const facts = challenge();
    harness.clock.advance(61_000);
    await expect(
      harness.auth.loginWithDeviceKey(exchangeBody(facts, signatureFor(facts))),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("签名错误：失败且不消费挑战，正确签名仍可兑换", async () => {
    const facts = challenge();
    const otherKey = createDeviceKey();
    await expect(
      harness.auth.loginWithDeviceKey(
        exchangeBody(facts, signatureFor(facts, otherKey.privateKey)),
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });

    const login = await harness.auth.loginWithDeviceKey(exchangeBody(facts, signatureFor(facts)));
    expect(login.data.deviceId).toBe(deviceId);
  });

  it("账号不匹配：另一个账号无法用该设备登录", () => {
    const code = gatewayCodeOf(() =>
      harness.auth.deviceChallenge({
        accountId: harness.bobId,
        negotiationId: NEGOTIATION,
        installationId: INSTALLATION,
        deviceId,
      }),
    );
    expect(code).toBe("AUTHENTICATION_FAILED");
  });

  it("安装不匹配：设备属于 install_device，换安装后拒绝", () => {
    negotiate(harness, { negotiationId: "neg_other", installationId: "install_other" });
    const code = gatewayCodeOf(() =>
      harness.auth.deviceChallenge({
        accountId: harness.aliceId,
        negotiationId: "neg_other",
        installationId: "install_other",
        deviceId,
      }),
    );
    expect(code).toBe("AUTHENTICATION_FAILED");
  });

  it("未知协商：PROTOCOL_INCOMPATIBLE", () => {
    const code = gatewayCodeOf(() =>
      harness.auth.deviceChallenge({
        accountId: harness.aliceId,
        negotiationId: "neg_missing",
        installationId: INSTALLATION,
        deviceId,
      }),
    );
    expect(code).toBe("PROTOCOL_INCOMPATIBLE");
  });

  it("设备已撤销：挑战返回 PAIRING_REQUIRED", () => {
    const store = harness.accounts.openStore(harness.aliceId);
    store?.revokeDevice(deviceId, nowIso(new Date(harness.clock.now)));
    expect(gatewayCodeOf(() => challenge())).toBe("PAIRING_REQUIRED");
  });

  it("挑战签发后设备被撤销：兑换返回 PAIRING_REQUIRED", async () => {
    const facts = challenge();
    harness.accounts
      .openStore(harness.aliceId)
      ?.revokeDevice(deviceId, nowIso(new Date(harness.clock.now)));
    await expect(
      harness.auth.loginWithDeviceKey(exchangeBody(facts, signatureFor(facts))),
    ).rejects.toMatchObject({ code: "PAIRING_REQUIRED" });
  });

  it("兑换请求 scope 与挑战不一致：AUTHENTICATION_FAILED", async () => {
    const facts = challenge();
    await expect(
      harness.auth.loginWithDeviceKey(
        exchangeBody(facts, signatureFor(facts), { negotiationId: "neg_other" }),
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("schema 校验：多余字段、同时给 accountId+username、缺签名都拒绝", async () => {
    expect(gatewayCodeOf(() => challenge({ extra: true }))).toBe("SCHEMA_INVALID");
    expect(
      gatewayCodeOf(() =>
        harness.auth.deviceChallenge({
          accountId: harness.aliceId,
          username: "alice",
          negotiationId: NEGOTIATION,
          installationId: INSTALLATION,
          deviceId,
        }),
      ),
    ).toBe("SCHEMA_INVALID");

    const facts = challenge();
    const missingSignature: JsonObject = {
      accountId: harness.aliceId,
      negotiationId: facts.negotiationId as string,
      installationId: facts.installationId as string,
      deviceId: facts.deviceId as string,
      challenge: facts.challenge as string,
    };
    await expect(harness.auth.loginWithDeviceKey(missingSignature)).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
  });
});
