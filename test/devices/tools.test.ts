import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEVICE_CANCEL_REQUESTED_EVENT,
  DEVICE_REQUESTED_EVENT,
} from "../../src/devices/device-service.js";
import { createDeviceTools, type DeviceTools } from "../../src/devices/tools.js";
import {
  ACCOUNT_ID,
  CONVERSATION_ID,
  createHarness,
  DEVICE_ID,
  GRANT_REVISION,
  PAIRING_GENERATION,
  sampleBinding,
  samplePublication,
  waitForEvent,
  type Harness,
} from "./helpers.js";

let harness: Harness;
let tools: DeviceTools;

const context = { accountId: ACCOUNT_ID, conversationId: CONVERSATION_ID };
const device = {
  deviceId: DEVICE_ID,
  pairingGeneration: PAIRING_GENERATION,
  grantRevision: GRANT_REVISION,
};

const exec = (signal: AbortSignal = new AbortController().signal) => ({
  agent: { session: { id: "sess_test" } },
  signal,
});

beforeEach(() => {
  harness = createHarness();
  tools = createDeviceTools({
    service: harness.service,
    resolveContext: () => context,
    resolveDevice: () => device,
  });
});

afterEach(() => {
  harness.cleanup();
});

describe("createDeviceTools 定义", () => {
  it("暴露两个普通对象工具与 JSON Schema / render", () => {
    expect(tools.capabilities.name).toBe("open_android_capabilities");
    expect(tools.device.name).toBe("open_android_device");
    for (const tool of [tools.capabilities, tools.device]) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect((tool.parameters as Record<string, unknown>).type).toBe("object");
      expect((tool.output.schema as Record<string, unknown>).type).toBe("object");
      const rendered = tool.output.render({}, { hello: "world" });
      expect(rendered).toEqual([{ type: "text", text: JSON.stringify({ hello: "world" }) }]);
    }
    expect((tools.device.parameters as Record<string, unknown>).required).toEqual([
      "capability",
      "parameters",
    ]);
    expect(
      ((tools.capabilities.output.schema as Record<string, unknown>).required as string[]).sort(),
    ).toEqual(["available", "capabilities", "diagnostics", "inventory"]);
  });
});

describe("open_android_capabilities", () => {
  it("无发布时 available=false 并给出诊断", async () => {
    const output = await tools.capabilities.execute({ includeInventory: true }, exec());
    expect(output.available).toBe(false);
    expect(output.capabilities).toEqual([]);
    expect(output.inventory).toEqual([]);
    expect(output.diagnostics).toBeInstanceOf(Array);
    expect((output.diagnostics as string[]).length).toBeGreaterThan(0);
  });

  it("有发布时返回绑定字段与可选本地清单", async () => {
    harness.service.publish(ACCOUNT_ID, samplePublication());

    const withoutInventory = await tools.capabilities.execute({}, exec());
    expect(withoutInventory.available).toBe(true);
    expect(withoutInventory.inventory).toEqual([]);
    expect(withoutInventory.capabilities).toEqual([
      {
        pluginId: "org.openandroidintelligence.sms",
        authorKeyId:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        capabilityId: "org.openandroidintelligence.sms.query",
        capabilityVersion: "1.0.0",
        risk: "read",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: { query: { type: "string", minLength: 1 } },
        },
      },
    ]);

    const withInventory = await tools.capabilities.execute({ includeInventory: true }, exec());
    expect(withInventory.inventory).toEqual([
      {
        pluginId: "org.openandroidintelligence.sms",
        capabilityId: "org.openandroidintelligence.sms.query",
        capabilityVersion: "1.0.0",
        status: "READY",
        reason: "",
      },
      {
        pluginId: "org.openandroidintelligence.sms",
        capabilityId: "org.openandroidintelligence.sms.send",
        capabilityVersion: "1.0.0",
        status: "ANDROID_PERMISSION_REQUIRED",
        reason: "READ_SMS_REQUIRED",
      },
    ]);
    expect(
      (withInventory.diagnostics as string[]).some((line) => line.includes("不可用")),
    ).toBe(true);
  });

  it("Agent 会话未绑定账号时 available=false", async () => {
    const unbound = createDeviceTools({
      service: harness.service,
      resolveContext: () => undefined,
      resolveDevice: () => undefined,
    });
    const output = await unbound.capabilities.execute({}, exec());
    expect(output.available).toBe(false);
    expect((output.diagnostics as string[])[0]).toContain("尚未绑定");
  });
});

describe("open_android_device", () => {
  it("按 capability 找到绑定并走完 request → claim → result", async () => {
    harness.service.publish(ACCOUNT_ID, samplePublication());
    const running = tools.device.execute(
      {
        capability: "org.openandroidintelligence.sms.query",
        parameters: { query: "from:alice" },
      },
      exec(),
    );

    const event = await waitForEvent(harness, DEVICE_REQUESTED_EVENT);
    const requestId = event.payload.requestId as string;
    expect(event.payload).toMatchObject({
      capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" },
      risk: "read",
      requiresForegroundConfirmation: false,
      grantRevision: GRANT_REVISION,
    });

    const receipt = harness.service.claim(harness.verified(), requestId, GRANT_REVISION);
    harness.service.submitResult(harness.verified(), requestId, {
      claimId: receipt.claimId,
      grantRevision: GRANT_REVISION,
      result: { outcome: "succeeded", data: { threads: 2 } },
    });

    const output = await running;
    expect(output).toEqual({
      requestId,
      outcome: "succeeded",
      data: { threads: 2 },
    });
    expect(tools.device.output.render({}, output)).toEqual([
      { type: "text", text: JSON.stringify(output) },
    ]);
  });

  it("省略 version 时选择已发布的最高版本", async () => {
    harness.service.publish(
      ACCOUNT_ID,
      samplePublication({
        bindings: [
          sampleBinding({ capabilityVersion: "1.0.0" }),
          sampleBinding({ capabilityVersion: "1.2.0" }),
        ],
      }),
    );
    const running = tools.device.execute(
      {
        capability: "org.openandroidintelligence.sms.query",
        parameters: { query: "from:alice" },
      },
      exec(),
    );
    const event = await waitForEvent(harness, DEVICE_REQUESTED_EVENT);
    const requestId = event.payload.requestId as string;
    expect((event.payload.capability as Record<string, unknown>).version).toBe("1.2.0");

    const receipt = harness.service.claim(harness.verified(), requestId, GRANT_REVISION);
    harness.service.submitResult(harness.verified(), requestId, {
      claimId: receipt.claimId,
      grantRevision: GRANT_REVISION,
      result: { outcome: "denied", data: { code: "CAPABILITY_DENIED" } },
    });
    expect(await running).toMatchObject({
      outcome: "denied",
      errorCode: "CAPABILITY_DENIED",
    });
  });

  it("无绑定返回 CAPABILITY_DENIED，且不创建请求", async () => {
    harness.service.publish(ACCOUNT_ID, samplePublication());
    const output = await tools.device.execute(
      { capability: "org.example.missing", parameters: {} },
      exec(),
    );
    expect(output.reason).toBe("CAPABILITY_DENIED");
    expect(output.requestId).toBeUndefined();
    expect(harness.events).toEqual([]);
  });

  it("无设备发布返回 CAPABILITY_DENIED", async () => {
    const output = await tools.device.execute(
      { capability: "org.openandroidintelligence.sms.query", parameters: {} },
      exec(),
    );
    expect(output.reason).toBe("CAPABILITY_DENIED");
    expect(harness.events).toEqual([]);
  });

  it("无同账号设备返回 DEVICE_UNAVAILABLE", async () => {
    harness.service.publish(ACCOUNT_ID, samplePublication());
    const noDevice = createDeviceTools({
      service: harness.service,
      resolveContext: () => context,
      resolveDevice: () => undefined,
    });
    const output = await noDevice.device.execute(
      {
        capability: "org.openandroidintelligence.sms.query",
        parameters: { query: "x" },
      },
      exec(),
    );
    expect(output.reason).toBe("DEVICE_UNAVAILABLE");
    expect(harness.events).toEqual([]);
  });

  it("high-privilege-ephemeral 不排队，返回 QUEUE_REJECTED", async () => {
    harness.service.publish(
      ACCOUNT_ID,
      samplePublication({
        bindings: [sampleBinding({ risk: "high-privilege-ephemeral" })],
      }),
    );
    const output = await tools.device.execute(
      {
        capability: "org.openandroidintelligence.sms.query",
        parameters: { query: "x" },
      },
      exec(),
    );
    expect(output.reason).toBe("QUEUE_REJECTED");
    expect(harness.events).toEqual([]);
    expect(harness.store().listPendingForDevice(DEVICE_ID)).toEqual([]);
  });

  it("非法参数返回 REQUEST_INVALID，不抛异常", async () => {
    harness.service.publish(ACCOUNT_ID, samplePublication());
    expect((await tools.device.execute({ capability: "", parameters: {} }, exec())).reason).toBe(
      "REQUEST_INVALID",
    );
    expect(
      (await tools.device.execute({ capability: "x", parameters: "not-an-object" }, exec())).reason,
    ).toBe("REQUEST_INVALID");
    expect((await tools.device.execute(null, exec())).reason).toBe("REQUEST_INVALID");
  });

  it("工具 abort 后返回取消状态而不是挂起", async () => {
    harness.service.publish(ACCOUNT_ID, samplePublication());
    const controller = new AbortController();
    const running = tools.device.execute(
      {
        capability: "org.openandroidintelligence.sms.query",
        parameters: { query: "from:alice" },
      },
      exec(controller.signal),
    );
    const event = await waitForEvent(harness, DEVICE_REQUESTED_EVENT);
    controller.abort();
    const output = await running;
    expect(output).toMatchObject({
      requestId: event.payload.requestId,
      outcome: "cancelled",
    });
    expect(
      harness.events.some((item) => item.type === DEVICE_CANCEL_REQUESTED_EVENT),
    ).toBe(true);
  });
});
