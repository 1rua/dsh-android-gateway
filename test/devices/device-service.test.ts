import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEVICE_CANCEL_REQUESTED_EVENT,
  DEVICE_REQUESTED_EVENT,
  DeviceCapabilityService,
} from "../../src/devices/device-service.js";
import { DeviceRequestStore } from "../../src/devices/device-store.js";
import type { DeviceRequestRecord } from "../../src/devices/contract.js";
import { GatewayError } from "../../src/shared/errors.js";
import {
  ACCOUNT_ID,
  createHarness,
  FIXED_NOW,
  GRANT_REVISION,
  PAIRING_GENERATION,
  requestInput,
  sampleBinding,
  samplePublication,
  waitForEvent,
  type Harness,
} from "./helpers.js";

const READ_TTL_MS = 86_400_000;
const WRITE_TTL_MS = 900_000;

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.cleanup();
});

const capture = (operation: () => unknown): unknown => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to throw");
};

const publishSample = (): void => {
  harness.service.publish(ACCOUNT_ID, samplePublication());
};

/** 创建一条请求并从 device.requested 事件里取回服务端生成的 requestId。 */
const createTrackedRequest = async (
  options: Parameters<typeof requestInput>[0],
): Promise<{ readonly promise: Promise<DeviceRequestRecord>; readonly requestId: string }> => {
  const promise = harness.service.createRequest(requestInput(options));
  const event = await waitForEvent(harness, DEVICE_REQUESTED_EVENT);
  return { promise, requestId: event.payload.requestId as string };
};

describe("DeviceCapabilityService.publish", () => {
  it("接受合法发布，并独立重算 JCS(Schema) 摘要", () => {
    const publication = samplePublication();
    harness.service.publish(ACCOUNT_ID, publication);
    const stored = harness.service.publication(ACCOUNT_ID);
    expect(stored).toEqual(publication);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.bindings[0])).toBe(true);
    expect(Object.isFrozen(stored?.bindings[0]?.schema)).toBe(true);
  });

  it("拒绝与 JCS(Schema) 不一致的 schemaSha256", () => {
    const bad = sampleBinding({
      schemaSha256:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    const error = capture(() =>
      harness.service.publish(ACCOUNT_ID, samplePublication({ bindings: [bad] })),
    );
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe("SCHEMA_INVALID");
    expect(harness.service.publication(ACCOUNT_ID)).toBeUndefined();
  });

  it("拒绝缺少字段、未知风险与重复绑定", () => {
    const missing = sampleBinding();
    const missingRecord = { ...missing } as Record<string, unknown>;
    delete missingRecord.pluginId;
    expect(
      capture(() =>
        harness.service.publish(
          ACCOUNT_ID,
          samplePublication({ bindings: [missingRecord as never] }),
        ),
      ),
    ).toMatchObject({ code: "SCHEMA_INVALID" });

    expect(
      capture(() =>
        harness.service.publish(
          ACCOUNT_ID,
          samplePublication({ bindings: [sampleBinding({ risk: "root" as never })] }),
        ),
      ),
    ).toMatchObject({ code: "SCHEMA_INVALID" });

    expect(
      capture(() =>
        harness.service.publish(
          ACCOUNT_ID,
          samplePublication({ bindings: [sampleBinding(), sampleBinding()] }),
        ),
      ),
    ).toMatchObject({ code: "SCHEMA_INVALID" });

    expect(
      capture(() =>
        harness.service.publish(
          ACCOUNT_ID,
          samplePublication({
            inventory: [
              {
                pluginId: "p",
                capabilityId: "c",
                capabilityVersion: "1",
                status: 7 as never,
                reason: "",
              },
            ],
          }),
        ),
      ),
    ).toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("发布持久化：服务重启后 publication 仍可恢复", () => {
    const publication = samplePublication();
    harness.service.publish(ACCOUNT_ID, publication);
    harness.service.close();

    const reopened = new DeviceCapabilityService({
      storeFor: (accountId) => {
        const dir = join(harness.rootDir, "accounts", accountId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return new DeviceRequestStore(join(dir, "device-requests.db"));
      },
      emit: () => undefined,
      now: () => new Date(FIXED_NOW),
    });
    try {
      expect(reopened.publication(ACCOUNT_ID)).toEqual(publication);
      expect(reopened.publication("acct_other")).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it("发布按账号隔离", () => {
    publishSample();
    expect(harness.service.publication(ACCOUNT_ID)).toBeDefined();
    expect(harness.service.publication("acct_other")).toBeUndefined();
  });
});

describe("DeviceCapabilityService create → claim → result", () => {
  it("发出精确的 device.requested 负载并在终态 resolve", async () => {
    const controller = new AbortController();
    const { promise, requestId } = await createTrackedRequest({ signal: controller.signal });

    const event = harness.events[0];
    expect(event?.type).toBe(DEVICE_REQUESTED_EVENT);
    expect(event?.accountId).toBe(ACCOUNT_ID);
    expect(Object.keys(event?.payload ?? {}).sort()).toEqual([
      "capability",
      "createdAt",
      "expiresAt",
      "grantRevision",
      "parameters",
      "provider",
      "requestId",
      "requiresForegroundConfirmation",
      "risk",
    ]);
    expect(event?.payload).toMatchObject({
      requestId,
      capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" },
      provider: {
        pluginId: "org.openandroidintelligence.sms",
        authorKeyId:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      parameters: { query: "from:alice" },
      risk: "read",
      grantRevision: GRANT_REVISION,
      requiresForegroundConfirmation: false,
    });
    expect(event?.payload.expiresAt).toBe(
      new Date(FIXED_NOW.getTime() + READ_TTL_MS).toISOString(),
    );

    expect(harness.service.pendingForDevice(ACCOUNT_ID, "dev_test")).toEqual([requestId]);

    const receipt = harness.service.claim(harness.verified(), requestId, GRANT_REVISION);
    expect(Object.keys(receipt).sort()).toEqual([
      "accountId",
      "claimId",
      "deviceId",
      "grantRevision",
      "pairingGeneration",
      "requestId",
    ]);
    expect(receipt).toMatchObject({
      requestId,
      accountId: ACCOUNT_ID,
      deviceId: "dev_test",
      pairingGeneration: PAIRING_GENERATION,
      grantRevision: GRANT_REVISION,
    });
    expect(receipt.claimId).toMatch(/^[A-Za-z0-9._~-]{1,128}$/);

    const record = harness.service.submitResult(harness.verified(), requestId, {
      claimId: receipt.claimId,
      grantRevision: GRANT_REVISION,
      result: { outcome: "succeeded", data: { threads: 2 } },
    });
    expect(record.state).toBe("succeeded");
    expect(record.result).toEqual({ outcome: "succeeded", data: { threads: 2 } });
    expect(record.errorCode).toBeNull();

    const settled = await promise;
    expect(settled.state).toBe("succeeded");
    expect(settled.requestId).toBe(requestId);
    expect(Object.isFrozen(settled)).toBe(true);
    expect(harness.service.pendingForDevice(ACCOUNT_ID, "dev_test")).toEqual([]);
  });

  it("claim 幂等：重复 claim 返回同一 receipt 且不改变状态", async () => {
    const controller = new AbortController();
    const { requestId } = await createTrackedRequest({ signal: controller.signal });
    const first = harness.service.claim(harness.verified(), requestId, GRANT_REVISION);
    const second = harness.service.claim(harness.verified(), requestId, GRANT_REVISION);
    expect(second).toEqual(first);
    expect(harness.store().get(requestId)?.state).toBe("claimed");
  });

  it("failed / denied 结果保存数据与稳定 errorCode", async () => {
    const controller = new AbortController();
    const { promise, requestId } = await createTrackedRequest({ signal: controller.signal });
    const receipt = harness.service.claim(harness.verified(), requestId, GRANT_REVISION);
    const failed = harness.service.submitResult(harness.verified(), requestId, {
      claimId: receipt.claimId,
      grantRevision: GRANT_REVISION,
      result: { outcome: "failed", data: { code: "PLUGIN_EXECUTION_FAILED" } },
    });
    expect(failed.state).toBe("failed");
    expect(failed.errorCode).toBe("PLUGIN_EXECUTION_FAILED");
    expect((await promise).state).toBe("failed");

    const other = await createTrackedRequest({ signal: new AbortController().signal });
    const otherReceipt = harness.service.claim(harness.verified(), other.requestId, GRANT_REVISION);
    const denied = harness.service.submitResult(harness.verified(), other.requestId, {
      claimId: otherReceipt.claimId,
      grantRevision: GRANT_REVISION,
      result: { outcome: "denied", data: { code: "CAPABILITY_DENIED", reason: "READ_SMS_REQUIRED" } },
    });
    expect(denied.state).toBe("denied");
    expect(denied.errorCode).toBe("CAPABILITY_DENIED");
  });

  it("相同内容重复提交幂等，不同内容拒绝", async () => {
    const controller = new AbortController();
    const { requestId } = await createTrackedRequest({ signal: controller.signal });
    const receipt = harness.service.claim(harness.verified(), requestId, GRANT_REVISION);
    const body = {
      claimId: receipt.claimId,
      grantRevision: GRANT_REVISION,
      result: { outcome: "succeeded" as const, data: { threads: 2 } },
    };
    const first = harness.service.submitResult(harness.verified(), requestId, body);
    const second = harness.service.submitResult(harness.verified(), requestId, body);
    expect(second).toEqual(first);

    expect(() =>
      harness.service.submitResult(harness.verified(), requestId, {
        claimId: receipt.claimId,
        grantRevision: GRANT_REVISION,
        result: { outcome: "failed" },
      }),
    ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  });
});

describe("DeviceCapabilityService 状态机与凭据校验", () => {
  it("未 claim 的 pending 请求不能直接提交结果", async () => {
    const controller = new AbortController();
    const { requestId } = await createTrackedRequest({ signal: controller.signal });
    const error = capture(() =>
      harness.service.submitResult(harness.verified(), requestId, {
        claimId: "claim_unissued",
        grantRevision: GRANT_REVISION,
        result: { outcome: "succeeded" },
      }),
    );
    expect((error as Error).message).toBe("INVALID_STATE_TRANSITION");
  });

  it("设备、generation 与 grantRevision 任一不匹配都拒绝 claim", async () => {
    const controller = new AbortController();
    const { requestId } = await createTrackedRequest({ signal: controller.signal });

    expect(() =>
      harness.service.claim(harness.verified({ deviceId: "dev_other" }), requestId, GRANT_REVISION),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }));
    expect(() =>
      harness.service.claim(
        harness.verified({ pairingGeneration: PAIRING_GENERATION + 1 }),
        requestId,
        GRANT_REVISION,
      ),
    ).toThrowError(expect.objectContaining({ code: "PAIRING_GENERATION_STALE" }));
    expect(() =>
      harness.service.claim(harness.verified(), requestId, GRANT_REVISION + 1),
    ).toThrowError(expect.objectContaining({ code: "GRANT_STALE" }));
  });

  it("result 的 claimId/grantRevision/设备必须与服务端 receipt 一致", async () => {
    const controller = new AbortController();
    const { requestId } = await createTrackedRequest({ signal: controller.signal });
    const receipt = harness.service.claim(harness.verified(), requestId, GRANT_REVISION);
    const validBody = {
      claimId: receipt.claimId,
      grantRevision: GRANT_REVISION,
      result: { outcome: "succeeded" as const },
    };

    expect(() =>
      harness.service.submitResult(harness.verified(), requestId, {
        ...validBody,
        claimId: "claim_other",
      }),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }));
    expect(() =>
      harness.service.submitResult(harness.verified(), requestId, {
        ...validBody,
        grantRevision: GRANT_REVISION + 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "GRANT_STALE" }));
    expect(() =>
      harness.service.submitResult(harness.verified({ deviceId: "dev_other" }), requestId, validBody),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }));
  });

  it("outcome_unknown 不允许 data，且不能被普通结果覆盖", async () => {
    const controller = new AbortController();
    const { requestId } = await createTrackedRequest({ signal: controller.signal });
    const receipt = harness.service.claim(harness.verified(), requestId, GRANT_REVISION);

    expect(() =>
      harness.service.submitResult(harness.verified(), requestId, {
        claimId: receipt.claimId,
        grantRevision: GRANT_REVISION,
        result: { outcome: "outcome_unknown", data: {} },
      }),
    ).toThrowError(expect.objectContaining({ code: "SCHEMA_INVALID" }));

    const unknown = harness.service.submitResult(harness.verified(), requestId, {
      claimId: receipt.claimId,
      grantRevision: GRANT_REVISION,
      result: { outcome: "outcome_unknown" },
    });
    expect(unknown.state).toBe("outcome_unknown");

    expect(() =>
      harness.service.submitResult(harness.verified(), requestId, {
        claimId: receipt.claimId,
        grantRevision: GRANT_REVISION,
        result: { outcome: "succeeded" },
      }),
    ).toThrowError(expect.objectContaining({ code: "OUTCOME_UNKNOWN" }));
  });

  it("未知 outcome、额外字段与非法状态迁移都按契约码拒绝", async () => {
    const controller = new AbortController();
    const { requestId } = await createTrackedRequest({ signal: controller.signal });
    const receipt = harness.service.claim(harness.verified(), requestId, GRANT_REVISION);

    expect(() =>
      harness.service.submitResult(harness.verified(), requestId, {
        claimId: receipt.claimId,
        grantRevision: GRANT_REVISION,
        result: { outcome: "ok" } as never,
      }),
    ).toThrowError(expect.objectContaining({ code: "SCHEMA_INVALID" }));
    expect(() =>
      harness.service.submitResult(harness.verified(), requestId, {
        claimId: receipt.claimId,
        grantRevision: GRANT_REVISION,
        result: { outcome: "succeeded", extra: true } as never,
      }),
    ).toThrowError(expect.objectContaining({ code: "SCHEMA_INVALID" }));
    expect(() =>
      harness.service.submitResult(harness.verified(), requestId, {
        claimId: receipt.claimId,
        grantRevision: GRANT_REVISION,
        result: { outcome: "succeeded" },
        deviceId: "dev_test",
      } as never),
    ).toThrowError(expect.objectContaining({ code: "SCHEMA_INVALID" }));

    harness.service.cancel(ACCOUNT_ID, requestId);
    expect(harness.store().get(requestId)?.state).toBe("cancel_requested");
    const error = capture(() => harness.service.cancel(ACCOUNT_ID, requestId));
    expect((error as Error).message).toBe("INVALID_STATE_TRANSITION");
  });
});

describe("DeviceCapabilityService 过期", () => {
  it("read 队列 24 小时，到期 pending → expired 并 resolve", async () => {
    const controller = new AbortController();
    const { promise, requestId } = await createTrackedRequest({
      signal: controller.signal,
      risk: "read",
    });
    const record = harness.store().get(requestId);
    expect(record).toBeDefined();
    expect(Date.parse(record!.expiresAt) - Date.parse(record!.createdAt)).toBe(READ_TTL_MS);

    harness.clock.now = new Date(FIXED_NOW.getTime() + READ_TTL_MS + 1);
    expect(harness.service.expireDue(ACCOUNT_ID, harness.clock.now.toISOString())).toBe(1);

    expect(harness.store().get(requestId)?.state).toBe("expired");
    expect(harness.store().get(requestId)?.errorCode).toBe("REQUEST_EXPIRED");
    expect((await promise).state).toBe("expired");
    expect(harness.service.pendingForDevice(ACCOUNT_ID, "dev_test")).toEqual([]);
  });

  it("write 队列 15 分钟，claimed 到期 → outcome_unknown", async () => {
    const controller = new AbortController();
    const { promise, requestId } = await createTrackedRequest({
      signal: controller.signal,
      risk: "write",
    });
    const record = harness.store().get(requestId);
    expect(Date.parse(record!.expiresAt) - Date.parse(record!.createdAt)).toBe(WRITE_TTL_MS);

    harness.service.claim(harness.verified(), requestId, GRANT_REVISION);
    harness.clock.now = new Date(FIXED_NOW.getTime() + WRITE_TTL_MS + 1);
    expect(harness.service.expireDue(ACCOUNT_ID, harness.clock.now.toISOString())).toBe(1);

    expect(harness.store().get(requestId)?.state).toBe("outcome_unknown");
    expect(harness.store().get(requestId)?.errorCode).toBe("OUTCOME_UNKNOWN");
    expect((await promise).state).toBe("outcome_unknown");
  });

  it("high-privilege-ephemeral 不排队，立即失败", async () => {
    await expect(
      harness.service.createRequest(
        requestInput({ signal: new AbortController().signal, risk: "high-privilege-ephemeral" }),
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(harness.events).toEqual([]);
    expect(harness.store().listPendingForDevice("dev_test")).toEqual([]);
  });
});

describe("DeviceCapabilityService 取消与 abort", () => {
  it("未 claim 时 abort：先发 cancel 事件，pending → cancelled 并 resolve", async () => {
    const controller = new AbortController();
    const { promise, requestId } = await createTrackedRequest({ signal: controller.signal });
    controller.abort();
    const settled = await promise;
    expect(settled.state).toBe("cancelled");

    const cancelEvents = harness.events.filter(
      (event) => event.type === DEVICE_CANCEL_REQUESTED_EVENT,
    );
    expect(cancelEvents).toEqual([
      { accountId: ACCOUNT_ID, type: DEVICE_CANCEL_REQUESTED_EVENT, payload: { requestId } },
    ]);
  });

  it("已 claim 时 abort：进入 cancel_requested 并 resolve 当前记录；迟到结果仍可信", async () => {
    const controller = new AbortController();
    const { promise, requestId } = await createTrackedRequest({ signal: controller.signal });
    const receipt = harness.service.claim(harness.verified(), requestId, GRANT_REVISION);
    controller.abort();
    const settled = await promise;
    expect(settled.state).toBe("cancel_requested");
    expect(harness.store().get(requestId)?.state).toBe("cancel_requested");

    const record = harness.service.submitResult(harness.verified(), requestId, {
      claimId: receipt.claimId,
      grantRevision: GRANT_REVISION,
      result: { outcome: "succeeded", data: { threads: 2 } },
    });
    expect(record.state).toBe("succeeded");
  });

  it("终态后 abort 不再发取消事件", async () => {
    const controller = new AbortController();
    const { promise, requestId } = await createTrackedRequest({ signal: controller.signal });
    const receipt = harness.service.claim(harness.verified(), requestId, GRANT_REVISION);
    harness.service.submitResult(harness.verified(), requestId, {
      claimId: receipt.claimId,
      grantRevision: GRANT_REVISION,
      result: { outcome: "succeeded" },
    });
    expect((await promise).state).toBe("succeeded");
    controller.abort();
    expect(
      harness.events.filter((event) => event.type === DEVICE_CANCEL_REQUESTED_EVENT),
    ).toEqual([]);
    expect(harness.store().get(requestId)?.state).toBe("succeeded");
  });

  it("public cancel：pending 立即 cancelled，claimed 只进入 cancel_requested", async () => {
    const first = await createTrackedRequest({ signal: new AbortController().signal });
    harness.service.cancel(ACCOUNT_ID, first.requestId);
    expect((await first.promise).state).toBe("cancelled");

    const second = await createTrackedRequest({ signal: new AbortController().signal });
    harness.service.claim(harness.verified(), second.requestId, GRANT_REVISION);
    harness.service.cancel(ACCOUNT_ID, second.requestId);
    expect(harness.store().get(second.requestId)?.state).toBe("cancel_requested");

    let resolved = false;
    void second.promise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it("close 会 resolve 等待中的 Promise 并拒绝后续请求", async () => {
    const creator = await createTrackedRequest({ signal: new AbortController().signal });
    harness.service.close();
    expect((await creator.promise).state).toBe("pending");
    await expect(
      harness.service.createRequest(
        requestInput({ signal: new AbortController().signal }),
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });
});

describe("DeviceCapabilityService detail", () => {
  it("返回 App 依赖的精确详情形状", async () => {
    const controller = new AbortController();
    const { requestId } = await createTrackedRequest({ signal: controller.signal });
    harness.service.claim(harness.verified(), requestId, GRANT_REVISION);

    const detail = harness.service.detail(harness.verified(), requestId);
    const request = detail.request as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual([
      "capability",
      "createdAt",
      "deviceId",
      "expiresAt",
      "grantRevision",
      "pairingGeneration",
      "parameters",
      "provider",
      "requestId",
      "requiresForegroundConfirmation",
      "risk",
      "state",
    ]);
    expect(request).toMatchObject({
      requestId,
      capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" },
      provider: {
        pluginId: "org.openandroidintelligence.sms",
        authorKeyId:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      parameters: { query: "from:alice" },
      risk: "read",
      grantRevision: GRANT_REVISION,
      deviceId: "dev_test",
      pairingGeneration: PAIRING_GENERATION,
      state: "claimed",
      requiresForegroundConfirmation: false,
    });
  });

  it("同一账号内按设备隔离，其他设备读不到", async () => {
    const controller = new AbortController();
    const { requestId } = await createTrackedRequest({ signal: controller.signal });
    expect(() =>
      harness.service.detail(harness.verified({ deviceId: "dev_other" }), requestId),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }));
  });

  it("过期请求在读取时也如实投影状态", async () => {
    const controller = new AbortController();
    const { promise, requestId } = await createTrackedRequest({
      signal: controller.signal,
      risk: "write",
    });
    harness.clock.now = new Date(FIXED_NOW.getTime() + WRITE_TTL_MS + 1);
    const detail = harness.service.detail(harness.verified(), requestId);
    expect((detail.request as Record<string, unknown>).state).toBe("expired");
    expect((await promise).state).toBe("expired");
  });
});
