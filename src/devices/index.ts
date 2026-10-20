/**
 * 设备能力子系统（契约 §10）的公开入口。
 *
 * - `DeviceRequestStore`：每账号 `node:sqlite` 请求存储（WAL、事务、冻结快照）；
 * - `DeviceCapabilityService`：能力发布、请求队列、claim/result、detail、过期与取消；
 * - `createDeviceTools`：两个可直接注册的模型工具定义。
 */
export type {
  CapabilityInventoryEntry,
  CapabilityPublication,
  CapabilityRisk,
  ClaimReceipt,
  CreateDeviceRequestInput,
  DeviceCapabilityServiceApi,
  DeviceLogger,
  DeviceRequestOutcome,
  DeviceRequestRecord,
  DeviceRequestResultBody,
  DeviceRequestState,
  PublishedCapabilityBinding,
} from "./contract.js";

export {
  ACTIVE_DEVICE_REQUEST_STATES,
  DeviceRequestNotFoundError,
  DeviceRequestStateConflictError,
  DeviceRequestStore,
  openDeviceRequestStore,
} from "./device-store.js";
export type {
  ActiveDeviceRequestState,
  DeviceRequestTransition,
} from "./device-store.js";

export {
  createDeviceCapabilityService,
  DEVICE_CANCEL_REQUESTED_EVENT,
  DEVICE_REQUESTED_EVENT,
  DeviceCapabilityService,
  schemaSha256Of,
} from "./device-service.js";
export type {
  DeviceCapabilityServiceOptions,
  DeviceEventEmitter,
} from "./device-service.js";

export { createDeviceTools } from "./tools.js";
export type {
  CreateDeviceToolsOptions,
  DeviceToolContext,
  DeviceToolDefinition,
  DeviceToolDevice,
  DeviceToolExecution,
  DeviceToolTextBlock,
  DeviceTools,
  MaybePromise,
} from "./tools.js";
