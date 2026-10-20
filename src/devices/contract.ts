import type { JsonObject, JsonValue, VerifiedRequest } from "../shared/types.js";

export type CapabilityRisk = "read" | "sync" | "write" | "high-privilege-ephemeral";

/** 手机通过 `POST /pairings/current/capabilities` 发布的单个能力绑定。 */
export interface PublishedCapabilityBinding {
  readonly pluginId: string;
  readonly authorKeyId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly schemaSha256: string;
  readonly schema: JsonObject;
  readonly risk: CapabilityRisk;
}

/** 手机侧能力清单（诊断用，不构成授权）。 */
export interface CapabilityInventoryEntry {
  readonly pluginId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly status: string;
  readonly reason: string;
}

export interface CapabilityPublication {
  readonly bindings: readonly PublishedCapabilityBinding[];
  readonly inventory: readonly CapabilityInventoryEntry[];
  readonly grantRevision: number;
  readonly updatedAt: string;
}

export type DeviceRequestState =
  | "pending"
  | "claimed"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled"
  | "expired"
  | "outcome_unknown";

export type DeviceRequestOutcome = "succeeded" | "failed" | "denied" | "cancelled" | "outcome_unknown";

export interface ClaimReceipt {
  readonly claimId: string;
  readonly requestId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly pairingGeneration: number;
  readonly grantRevision: number;
}

export interface DeviceRequestRecord {
  readonly requestId: string;
  readonly conversationId: string;
  readonly deviceId: string;
  readonly pairingGeneration: number;
  readonly capability: { readonly id: string; readonly version: string };
  readonly provider: { readonly pluginId: string; readonly authorKeyId: string };
  readonly parameters: JsonObject;
  readonly risk: CapabilityRisk;
  readonly grantRevision: number;
  readonly requiresForegroundConfirmation: boolean;
  readonly state: DeviceRequestState;
  readonly claimId: string | null;
  readonly result: JsonValue | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CreateDeviceRequestInput {
  readonly accountId: string;
  readonly conversationId: string;
  readonly device: { readonly deviceId: string; readonly pairingGeneration: number };
  readonly capability: { readonly id: string; readonly version: string };
  readonly provider: { readonly pluginId: string; readonly authorKeyId: string };
  readonly parameters: JsonObject;
  readonly risk: CapabilityRisk;
  readonly grantRevision: number;
  readonly requiresForegroundConfirmation: boolean;
  readonly signal: AbortSignal;
}

export interface DeviceRequestResultBody {
  readonly claimId: string;
  readonly grantRevision: number;
  readonly result: JsonObject;
}

/**
 * 设备能力子系统（契约 §10）。
 *
 * 手机发布能力绑定后，模型工具通过 `createRequest` 发起结构化请求，
 * App 用 `claim` → 本地执行 → `result` 完成；状态机与队列期限由实现保证。
 */
export interface DeviceCapabilityServiceApi {
  /** 保存一次能力发布（由 PairingService 在摘要校验通过后调用）。 */
  publish(accountId: string, publication: CapabilityPublication): void;
  publication(accountId: string): CapabilityPublication | undefined;
  createRequest(input: CreateDeviceRequestInput): Promise<DeviceRequestRecord>;
  claim(request: VerifiedRequest, requestId: string, grantRevision: number): ClaimReceipt;
  submitResult(request: VerifiedRequest, requestId: string, body: DeviceRequestResultBody): DeviceRequestRecord;
  detail(request: VerifiedRequest, requestId: string): JsonObject;
  pendingForDevice(accountId: string, deviceId: string): readonly string[];
  cancel(accountId: string, requestId: string): void;
  expireDue(accountId: string, now?: string): number;
  close(): void;
}

export interface DeviceLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
