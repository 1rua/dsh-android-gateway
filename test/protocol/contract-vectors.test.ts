import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CORE_SCHEMA_HASH,
  canonicalRequestSignatureInput,
  canonicalRequestTarget,
  nextAttachmentState,
  nextDeviceRequestState,
  type GatewaySchemaName,
} from "../../src/protocol/index.js";
import { validateGatewayValue } from "../../contract/src/schema-registry.js";
import type { AttachmentEvent, AttachmentState, DeviceRequestEvent, DeviceRequestState } from "../../contract/src/state-machines.js";

const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "contract", "vectors");

interface VectorCase {
  readonly id: string;
  readonly operation: string;
  readonly input: Record<string, unknown>;
  readonly expected:
    | { readonly outcome: "value"; readonly value: Record<string, unknown> }
    | { readonly outcome: "error"; readonly code: string };
}

const readVector = (file: string): { vectorSet: string; cases: readonly VectorCase[] } =>
  JSON.parse(readFileSync(join(ROOT, file), "utf8")) as {
    vectorSet: string;
    cases: readonly VectorCase[];
  };

const errorCodeOf = (task: () => unknown): string | undefined => {
  try {
    task();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message.split(":")[0] : "UNKNOWN";
  }
};

describe("Gateway Protocol v2.1 契约向量", () => {
  it("核心 Schema 摘要与 App 硬编码一致", () => {
    expect(CORE_SCHEMA_HASH).toBe(
      "sha256:032f580246eb4a214624bded717819b4d5a76191208207edc9e5a4607f5c4d23",
    );
  });

  it("解析规范化 target 并拒绝非规范输入", () => {
    const vectors = readVector("request-signatures.json");
    for (const vector of vectors.cases.filter((entry) => entry.operation === "request.target")) {
      const target = String(vector.input.target);
      if (vector.expected.outcome === "value") {
        expect(canonicalRequestTarget(target), vector.id).toBe(vector.expected.value.canonicalTarget);
      } else {
        expect(errorCodeOf(() => canonicalRequestTarget(target)), vector.id).toBe(vector.expected.code);
      }
    }
  });

  it("签名预像与黄金向量逐字节一致", () => {
    const vectors = readVector("request-signatures.json");
    for (const vector of vectors.cases.filter((entry) => entry.operation === "request.signature")) {
      const input = vector.input as Record<string, string | undefined>;
      const field = (name: string): string => input[name] ?? "";
      const build = () =>
        canonicalRequestSignatureInput({
          method: field("method") as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
          target: field("target"),
          accountId: field("accountId"),
          deviceId: field("deviceId"),
          sessionId: field("sessionId"),
          requestId: field("requestId"),
          timestamp: field("timestamp"),
          nonce: field("nonce"),
          body: Buffer.from(field("bodyHex"), "hex"),
        });
      if (vector.expected.outcome === "value") {
        expect(Buffer.from(build()).toString("hex"), vector.id).toBe(vector.expected.value.preimageHex);
      } else {
        expect(errorCodeOf(build), vector.id).toBe(vector.expected.code);
      }
    }
  });

  it("Schema 校验向量全部通过", () => {
    const files = [
      "protocol-negotiation.json",
      "auth-sessions.json",
      "attachments.json",
      "sse-events.json",
    ] as const;
    let checked = 0;
    for (const file of files) {
      const vectors = readVector(file);
      for (const vector of vectors.cases) {
        if (vector.operation !== "schema.validate") continue;
        const schemaName = String(vector.input.schemaName) as GatewaySchemaName;
        const value = vector.input.value;
        const result = validateGatewayValue(schemaName, value);
        if (vector.expected.outcome === "value") {
          expect(result.ok, `${file}#${vector.id}`).toBe(true);
        } else {
          expect(result.ok, `${file}#${vector.id}`).toBe(false);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("附件状态机遵循契约闭集", () => {
    const vectors = readVector("attachments.json");
    for (const vector of vectors.cases.filter((entry) => entry.operation === "attachment.transition")) {
      const input = vector.input as { current: AttachmentState; event: AttachmentEvent };
      if (vector.expected.outcome === "value") {
        expect(nextAttachmentState(input.current, input.event), vector.id).toBe(
          vector.expected.value.nextState,
        );
      } else {
        expect(errorCodeOf(() => nextAttachmentState(input.current, input.event)), vector.id).toBe(
          "INVALID_STATE_TRANSITION",
        );
      }
    }
  });

  it("设备请求状态机遵循契约闭集", () => {
    const vectors = readVector("device-requests.json");
    for (const vector of vectors.cases.filter((entry) => entry.operation === "device.transition")) {
      const input = vector.input as { current: DeviceRequestState; event: DeviceRequestEvent };
      if (vector.expected.outcome === "value") {
        expect(nextDeviceRequestState(input.current, input.event), vector.id).toBe(
          vector.expected.value.nextState,
        );
      } else {
        expect(errorCodeOf(() => nextDeviceRequestState(input.current, input.event)), vector.id).toBe(
          "INVALID_STATE_TRANSITION",
        );
      }
    }
  });
});
