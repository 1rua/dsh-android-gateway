import { createHash } from "node:crypto";
import { appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

import canonicalize from "canonicalize";

import { GatewayError } from "../shared/errors.js";
import type { JsonObject, JsonValue, VerifiedRequest } from "../shared/types.js";
import type { AccountManager } from "./accounts.js";
import type { CapabilityInventoryEntry, CapabilityPublication, DeviceCapabilityServiceApi, PublishedCapabilityBinding } from "../devices/contract.js";
import type { GatewayEventHub } from "./event-hub.js";

export interface PairingServiceOptions {
  readonly accounts: AccountManager;
  readonly events: GatewayEventHub;
  readonly devices?: DeviceCapabilityServiceApi;
  readonly logger?: { warn(message: string): void };
}

const sha256 = (value: JsonValue): string =>
  `sha256:${createHash("sha256").update(canonicalize(value) ?? "null").digest("hex")}`;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * 配对授权状态（契约 §11）。
 *
 * v0.1 不实现设备插件能力，因此 `capabilities` 始终为空、`capabilityPolicy` 为 null；
 * 但 App 每 5 秒轮询 `GET /pairings/current`，并在收到摘要不一致时发布一次
 * `POST /pairings/current/capabilities`，所以这两个端点必须存在且摘要算法与 App 一致，
 * 否则手机端会持续显示同步失败。发布空能力只是「如实告诉手机：当前没有宿主侧授权」，
 * 不承诺任何设备能力。
 */
export class PairingService {
  readonly #options: PairingServiceOptions;

  constructor(options: PairingServiceOptions) {
    this.#options = options;
  }

  get(verified: VerifiedRequest): JsonObject {
    const state = this.#options.accounts.readPairingState(verified.accountId);
    return {
      grantRevision: state.grantRevision,
      grantDigest: state.grantDigest,
      capabilityPolicy: null,
      capabilities: [],
      capabilityPublicationVersion: state.capabilityPublicationVersion,
      pairingGeneration: verified.device.pairingGeneration,
    };
  }

  #diagnostics(message: string): void {
    try {
      const path = join(this.#options.accounts.rootDir, "diagnostics.log");
      appendFileSync(path, `${new Date().toISOString()}\tpairing\t${message}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    } catch {
      // 诊断不得影响协议响应。
    }
  }

  async publishCapabilities(
    verified: VerifiedRequest,
    body: JsonObject | null,
  ): Promise<JsonObject> {
    if (body === null) throw new GatewayError("SCHEMA_INVALID", "Missing capability publication body");
    const bindings = body.bindings;
    if (!Array.isArray(bindings)) {
      throw new GatewayError("SCHEMA_INVALID", "bindings must be an array");
    }
    const localGrantRevision = Number(body.localGrantRevision);
    if (!Number.isSafeInteger(localGrantRevision) || localGrantRevision < 0) {
      throw new GatewayError("SCHEMA_INVALID", "localGrantRevision must be a non-negative integer");
    }
    const expectedGrantRevision = Number(body.expectedGrantRevision);
    if (!Number.isSafeInteger(expectedGrantRevision) || expectedGrantRevision < 0) {
      throw new GatewayError("SCHEMA_INVALID", "expectedGrantRevision must be a non-negative integer");
    }
    const state = this.#options.accounts.readPairingState(verified.accountId);
    if (expectedGrantRevision !== state.grantRevision) {
      this.#diagnostics(`reject GRANT_STALE expected=${expectedGrantRevision} current=${state.grantRevision}`);
      throw new GatewayError("GRANT_STALE", "grantRevision is stale", {
        details: { expectedGrantRevision, current: state.grantRevision },
      });
    }
    const inventory = body.inventory;
    this.#diagnostics(
      `publish device=${verified.deviceId} expected=${expectedGrantRevision} current=${state.grantRevision} bindings=${bindings.length} inventory=${Array.isArray(inventory) ? "array" : typeof inventory}`,
    );
    const digestSource: Record<string, JsonValue> = {
      bindings: bindings as JsonValue,
      localGrantRevision,
    };
    if (inventory !== undefined) digestSource.inventory = inventory as JsonValue;
    const grantDigest = sha256(digestSource as JsonValue);

    if (grantDigest === state.grantDigest) {
      return { grantRevision: state.grantRevision, grantDigest };
    }
    const grantRevision = state.grantRevision + 1;
    this.#diagnostics(`accept revision=${grantRevision} digest=${grantDigest.slice(0, 20)}`);
    const publication: CapabilityPublication = {
      bindings: bindings as unknown as PublishedCapabilityBinding[],
      inventory: (Array.isArray(inventory) ? inventory : []) as unknown as CapabilityInventoryEntry[],
      grantRevision,
      updatedAt: new Date().toISOString(),
    };
    // 先交给设备子系统做 Schema 摘要复核；失败则整个发布不生效。
    this.#options.devices?.publish(verified.accountId, publication);
    this.#options.accounts.writePairingState(verified.accountId, {
      grantRevision,
      grantDigest,
      capabilityPublicationVersion: state.capabilityPublicationVersion,
      capabilities: {
        bindings: bindings as unknown[],
        inventory: (Array.isArray(inventory) ? inventory : []) as unknown[],
        updatedAt: publication.updatedAt,
        deviceId: verified.deviceId,
      },
    });
    try {
      await this.#options.events.publish(verified.accountId, {
        type: "pairing.grant.changed",
        payload: { deviceId: verified.deviceId, grantRevision } as JsonObject,
        correlationId: verified.requestId,
      });
    } catch (error) {
      this.#options.logger?.warn(
        `[dsh-android-gateway] pairing grant event failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { grantRevision, grantDigest };
  }
}

export { asRecord };
