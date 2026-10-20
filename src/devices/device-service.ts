import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import {
  maximumDeviceRequestQueueSeconds,
  nextDeviceRequestState,
} from "../../contract/src/state-machines.js";
import { GatewayError } from "../shared/errors.js";
import {
  createWireId,
  isWireId,
  nowIso as isoOf,
  UTC_MILLIS_PATTERN,
} from "../shared/ids.js";
import type { JsonObject, JsonValue, VerifiedRequest } from "../shared/types.js";
import type {
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
import {
  DeviceRequestStateConflictError,
  DeviceRequestStore,
} from "./device-store.js";

/** 契约 §9 的事件类型：设备唤醒与取消意图。 */
export const DEVICE_REQUESTED_EVENT = "device.requested";
export const DEVICE_CANCEL_REQUESTED_EVENT = "device.request.cancel.requested";

const RISK_VALUES: readonly CapabilityRisk[] = [
  "read",
  "sync",
  "write",
  "high-privilege-ephemeral",
];

const OUTCOME_VALUES: readonly DeviceRequestOutcome[] = [
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "outcome_unknown",
];

/** 结果 outcome → 契约状态机事件（§10）。 */
const RESULT_EVENTS = {
  succeeded: "result_succeeded",
  failed: "result_failed",
  denied: "result_denied",
  cancelled: "result_cancelled",
  outcome_unknown: "result_outcome_unknown",
} as const satisfies Readonly<Record<DeviceRequestOutcome, string>>;

const TERMINAL_STATES: ReadonlySet<DeviceRequestState> = new Set([
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "expired",
  "outcome_unknown",
]);

const ACTIVE_STATES: ReadonlySet<DeviceRequestState> = new Set([
  "pending",
  "claimed",
  "cancel_requested",
]);

const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const RESULT_KEYS: ReadonlySet<string> = new Set(["outcome", "data"]);
const RESULT_BODY_KEYS: ReadonlySet<string> = new Set(["claimId", "grantRevision", "result"]);

/** 事件发射器：由 Lead 注入（测试里是假实现，生产里包一层 GatewayEventHub）。 */
export type DeviceEventEmitter = (
  accountId: string,
  type: string,
  payload: JsonObject,
) => void | Promise<void>;

export interface DeviceCapabilityServiceOptions {
  /** 每账号打开（或复用）设备请求库；目录权限与路径由调用方保证。 */
  readonly storeFor: (accountId: string) => DeviceRequestStore;
  /** 构造参数注入的事件发射器，不直接依赖 GatewayEventHub。 */
  readonly emit: DeviceEventEmitter;
  readonly now?: () => Date;
  readonly logger?: DeviceLogger;
}

interface Waiter {
  readonly accountId: string;
  readonly requestId: string;
  /** 关闭服务时若读不到最新行，用它兜底 resolve，避免工具永久挂起。 */
  readonly initial: DeviceRequestRecord;
  readonly resolve: (record: DeviceRequestRecord) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isPlainObject(value) ? value : undefined;

const invalid = (message: string): GatewayError => new GatewayError("SCHEMA_INVALID", message);

const requireNonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`${field} must be a non-empty string`);
  }
  return value;
};

const requirePrefixedSha256 = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !PREFIXED_SHA256.test(value)) {
    throw invalid(`${field} must be "sha256:<64 lowercase hex>"`);
  }
  return value;
};

const requireNonNegativeInteger = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be a non-negative integer`);
  }
  return value;
};

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") throw invalid(`${field} must be a boolean`);
  return value;
};

const requireRisk = (value: unknown, field: string): CapabilityRisk => {
  const risk = requireNonEmptyString(value, field);
  if (!RISK_VALUES.includes(risk as CapabilityRisk)) throw invalid(`${field} is not a known risk`);
  return risk as CapabilityRisk;
};

/** 深冻结：对外暴露的 JSON 快照不可被调用方改写。 */
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
};

/** JSON 拷贝：既保证存储的是纯 JSON，也把内部对象与调用方引用彻底解耦。 */
const cloneJsonObject = (value: unknown, field: string): JsonObject => {
  if (!isPlainObject(value)) throw invalid(`${field} must be a JSON object`);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalid(`${field} is not JSON serializable`);
  }
  if (serialized === undefined) throw invalid(`${field} is not JSON serializable`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw invalid(`${field} is not JSON serializable`);
  }
  if (!isPlainObject(parsed)) throw invalid(`${field} must be a JSON object`);
  return deepFreeze(parsed as JsonObject);
};

/** 契约使用的 JCS + SHA-256 摘要（与 pairing-service、Android 侧 `Json.sha256` 一致）。 */
export const schemaSha256Of = (schema: JsonObject): string => {
  let canonical: string | undefined;
  try {
    canonical = canonicalize(schema);
  } catch {
    throw invalid("schema is not canonical JSON");
  }
  if (canonical === undefined) throw invalid("schema is not canonical JSON");
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
};

const jsonEquals = (left: JsonValue | null, right: JsonValue): boolean => {
  if (left === null) return false;
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
};

const isTerminal = (state: DeviceRequestState): boolean => TERMINAL_STATES.has(state);

const isActive = (state: DeviceRequestState): boolean => ACTIVE_STATES.has(state);

interface ValidatedCreateInput {
  readonly accountId: string;
  readonly conversationId: string;
  readonly deviceId: string;
  readonly pairingGeneration: number;
  readonly capability: { readonly id: string; readonly version: string };
  readonly provider: { readonly pluginId: string; readonly authorKeyId: string };
  readonly parameters: JsonObject;
  readonly risk: CapabilityRisk;
  readonly grantRevision: number;
  readonly requiresForegroundConfirmation: boolean;
  readonly signal: AbortSignal;
}

/**
 * 设备能力子系统（契约 §10）。
 *
 * 职责：
 * - 保存并校验手机发布的能力绑定（Schema 摘要独立重算）；
 * - 维护按风险分级的请求队列：写入 pending 后 emit `device.requested`，返回
 *   一个在终态（或调用方中止）时 resolve 的 Promise；
 * - claim / result 按服务端 receipt 绑定账号、设备、generation、grantRevision；
 * - 状态迁移完全委托 `contract/src/state-machines.ts` 的纯 reducer，非法迁移抛
 *   `INVALID_STATE_TRANSITION`；
 * - 过期、取消、关闭都保证等待中的 Promise 被 resolve，不让工具永久挂起。
 */
export class DeviceCapabilityService implements DeviceCapabilityServiceApi {
  readonly #options: DeviceCapabilityServiceOptions;
  readonly #now: () => Date;
  readonly #publications = new Map<string, CapabilityPublication>();
  readonly #stores = new Map<string, DeviceRequestStore>();
  readonly #waiters = new Map<string, Waiter>();
  #closed = false;

  constructor(options: DeviceCapabilityServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  #assertOpen(): void {
    if (this.#closed) {
      throw new GatewayError("CAPABILITY_UNAVAILABLE", "Device capability service is closed", {
        httpStatus: 503,
      });
    }
  }

  #store(accountId: string): DeviceRequestStore {
    const cached = this.#stores.get(accountId);
    if (cached !== undefined) return cached;
    const store = this.#options.storeFor(accountId);
    this.#stores.set(accountId, store);
    return store;
  }

  #nowDate(): Date {
    return this.#now();
  }

  #nowIso(): string {
    return isoOf(this.#nowDate());
  }

  #nowMillis(): number {
    return this.#nowDate().getTime();
  }

  #warn(message: string, error: unknown): void {
    try {
      this.#options.logger?.warn(
        `[dsh-android-gateway] ${message}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } catch {
      // 日志失败不得影响协议路径。
    }
  }

  /** 事件在业务状态写入后调用；发射失败只记日志，不回滚已提交的写入。 */
  #emit(accountId: string, type: string, payload: JsonObject): void {
    try {
      const result = this.#options.emit(accountId, type, payload);
      if (result !== undefined && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch((error: unknown) => this.#warn("event emit failed", error));
      }
    } catch (error) {
      this.#warn("event emit failed", error);
    }
  }

  /** 关闭服务：先让所有等待中的 Promise 以最新（或初始）记录 resolve，再关闭库。 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [requestId, waiter] of [...this.#waiters]) {
      const store = this.#stores.get(waiter.accountId);
      let record: DeviceRequestRecord | undefined;
      try {
        record = store?.get(requestId);
      } catch {
        record = undefined;
      }
      this.#detach(waiter);
      this.#waiters.delete(requestId);
      waiter.resolve(record ?? waiter.initial);
    }
    for (const store of this.#stores.values()) {
      try {
        store.close();
      } catch (error) {
        this.#warn("device-request store close failed", error);
      }
    }
    this.#stores.clear();
    this.#publications.clear();
  }

  #detach(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  /** 精确一次 settle：先从表里摘除再 resolve，重复调用不会二次 resolve。 */
  #settle(record: DeviceRequestRecord): void {
    const waiter = this.#waiters.get(record.requestId);
    if (waiter === undefined) return;
    this.#waiters.delete(record.requestId);
    this.#detach(waiter);
    waiter.resolve(record);
  }

  // ---------------------------------------------------------------------------
  // 能力发布
  // ---------------------------------------------------------------------------

  publish(accountId: string, publication: CapabilityPublication): void {
    this.#assertOpen();
    const validated = this.#validatePublication(accountId, publication);
    // 先落库再进内存：DSH 重启后 App 不会因摘要未变而重发，必须由本服务恢复。
    this.#store(accountId).savePublication(this.#publicationJson(validated));
    this.#publications.set(accountId, validated);
  }

  publication(accountId: string): CapabilityPublication | undefined {
    this.#assertOpen();
    const cached = this.#publications.get(accountId);
    if (cached !== undefined) return cached;
    const stored = this.#store(accountId).loadPublication();
    if (stored === undefined) return undefined;
    try {
      const validated = this.#validatePublication(
        accountId,
        stored as unknown as CapabilityPublication,
      );
      this.#publications.set(accountId, validated);
      return validated;
    } catch (error) {
      this.#warn(`persisted capability publication for ${accountId} is invalid`, error);
      return undefined;
    }
  }

  #publicationJson(publication: CapabilityPublication): JsonObject {
    return {
      bindings: publication.bindings.map((binding) => ({
        pluginId: binding.pluginId,
        authorKeyId: binding.authorKeyId,
        capabilityId: binding.capabilityId,
        capabilityVersion: binding.capabilityVersion,
        schemaSha256: binding.schemaSha256,
        schema: binding.schema,
        risk: binding.risk,
      })),
      inventory: publication.inventory.map((entry) => ({
        pluginId: entry.pluginId,
        capabilityId: entry.capabilityId,
        capabilityVersion: entry.capabilityVersion,
        status: entry.status,
        reason: entry.reason,
      })),
      grantRevision: publication.grantRevision,
      updatedAt: publication.updatedAt,
    };
  }

  #validatePublication(accountId: string, publication: CapabilityPublication): CapabilityPublication {
    if (!isWireId(accountId)) throw invalid("accountId must be a wire ID");
    const record = asRecord(publication);
    if (record === undefined) throw invalid("publication must be an object");
    if (!Array.isArray(record.bindings)) throw invalid("publication.bindings must be an array");
    if (!Array.isArray(record.inventory)) throw invalid("publication.inventory must be an array");
    const grantRevision = requireNonNegativeInteger(
      record.grantRevision,
      "publication.grantRevision",
    );
    const updatedAt = requireNonEmptyString(record.updatedAt, "publication.updatedAt");
    if (!UTC_MILLIS_PATTERN.test(updatedAt)) {
      throw invalid("publication.updatedAt must be an RFC 3339 UTC millis timestamp");
    }

    const seen = new Set<string>();
    const bindings: PublishedCapabilityBinding[] = [];
    for (const [index, rawBinding] of record.bindings.entries()) {
      const binding = asRecord(rawBinding);
      if (binding === undefined) throw invalid(`bindings[${index}] must be an object`);
      const pluginId = requireNonEmptyString(binding.pluginId, `bindings[${index}].pluginId`);
      const authorKeyId = requirePrefixedSha256(
        binding.authorKeyId,
        `bindings[${index}].authorKeyId`,
      );
      const capabilityId = requireNonEmptyString(
        binding.capabilityId,
        `bindings[${index}].capabilityId`,
      );
      const capabilityVersion = requireNonEmptyString(
        binding.capabilityVersion,
        `bindings[${index}].capabilityVersion`,
      );
      const schemaSha256 = requirePrefixedSha256(
        binding.schemaSha256,
        `bindings[${index}].schemaSha256`,
      );
      if (!isPlainObject(binding.schema)) {
        throw invalid(`bindings[${index}].schema must be a JSON object`);
      }
      const schema = cloneJsonObject(binding.schema, `bindings[${index}].schema`);
      const risk = requireRisk(binding.risk, `bindings[${index}].risk`);
      // 独立重算：手机声明的摘要必须与 JCS(schema) 的 SHA-256 完全一致。
      const recomputed = schemaSha256Of(schema);
      if (recomputed !== schemaSha256) {
        throw invalid(
          `bindings[${index}].schemaSha256 does not match sha256(JCS(schema))`,
        );
      }
      const key = `${pluginId}\u0000${authorKeyId}\u0000${capabilityId}\u0000${capabilityVersion}`;
      if (seen.has(key)) {
        throw invalid(`bindings[${index}] duplicates capability ${capabilityId}@${capabilityVersion}`);
      }
      seen.add(key);
      bindings.push(
        deepFreeze({
          pluginId,
          authorKeyId,
          capabilityId,
          capabilityVersion,
          schemaSha256,
          schema,
          risk,
        }),
      );
    }

    const inventory: CapabilityInventoryEntry[] = [];
    for (const [index, rawEntry] of record.inventory.entries()) {
      const entry = asRecord(rawEntry);
      if (entry === undefined) throw invalid(`inventory[${index}] must be an object`);
      const pluginId = requireNonEmptyString(entry.pluginId, `inventory[${index}].pluginId`);
      const capabilityId = requireNonEmptyString(
        entry.capabilityId,
        `inventory[${index}].capabilityId`,
      );
      const capabilityVersion = requireNonEmptyString(
        entry.capabilityVersion,
        `inventory[${index}].capabilityVersion`,
      );
      if (typeof entry.status !== "string") {
        throw invalid(`inventory[${index}].status must be a string`);
      }
      if (typeof entry.reason !== "string") {
        throw invalid(`inventory[${index}].reason must be a string`);
      }
      inventory.push(
        deepFreeze({
          pluginId,
          capabilityId,
          capabilityVersion,
          status: entry.status,
          reason: entry.reason,
        }),
      );
    }

    return deepFreeze({
      bindings: Object.freeze(bindings),
      inventory: Object.freeze(inventory),
      grantRevision,
      updatedAt,
    });
  }

  // ---------------------------------------------------------------------------
  // 创建请求
  // ---------------------------------------------------------------------------

  async createRequest(input: CreateDeviceRequestInput): Promise<DeviceRequestRecord> {
    this.#assertOpen();
    const validated = this.#validateCreateInput(input);
    const maximumSeconds = maximumDeviceRequestQueueSeconds(validated.risk);
    if (maximumSeconds === 0) {
      // high-privilege-ephemeral：离线即失败，绝不进入队列。
      throw new GatewayError(
        "CAPABILITY_UNAVAILABLE",
        "high-privilege-ephemeral requests must be executed while the device is online and cannot be queued",
      );
    }
    const createdAt = this.#nowIso();
    const expiresAt = new Date(this.#nowMillis() + maximumSeconds * 1000).toISOString();
    const record: DeviceRequestRecord = deepFreeze({
      requestId: createWireId("dreq_"),
      conversationId: validated.conversationId,
      deviceId: validated.deviceId,
      pairingGeneration: validated.pairingGeneration,
      capability: Object.freeze({ ...validated.capability }),
      provider: Object.freeze({ ...validated.provider }),
      parameters: validated.parameters,
      risk: validated.risk,
      grantRevision: validated.grantRevision,
      requiresForegroundConfirmation: validated.requiresForegroundConfirmation,
      state: "pending",
      claimId: null,
      result: null,
      errorCode: null,
      createdAt,
      expiresAt,
    });

    const store = this.#store(validated.accountId);
    store.insert(record);
    const promise = this.#registerWaiter(validated.accountId, record, validated.signal);

    this.#emit(validated.accountId, DEVICE_REQUESTED_EVENT, this.#requestedPayload(record));
    // 传入的 signal 可能在创建过程中就已中止：立刻按取消语义收敛。
    if (validated.signal.aborted) this.#abort(validated.accountId, record.requestId);
    return promise;
  }

  #validateCreateInput(input: CreateDeviceRequestInput): ValidatedCreateInput {
    const record = asRecord(input);
    if (record === undefined) throw invalid("createRequest input must be an object");
    const accountId = requireNonEmptyString(record.accountId, "accountId");
    if (!isWireId(accountId)) throw invalid("accountId must be a wire ID");
    const conversationId = requireNonEmptyString(record.conversationId, "conversationId");
    if (!isWireId(conversationId)) throw invalid("conversationId must be a wire ID");
    const device = asRecord(record.device);
    if (device === undefined) throw invalid("device must be an object");
    const deviceId = requireNonEmptyString(device.deviceId, "device.deviceId");
    if (!isWireId(deviceId)) throw invalid("device.deviceId must be a wire ID");
    const pairingGeneration = requireNonNegativeInteger(
      device.pairingGeneration,
      "device.pairingGeneration",
    );
    const capability = asRecord(record.capability);
    if (capability === undefined) throw invalid("capability must be an object");
    const capabilityId = requireNonEmptyString(capability.id, "capability.id");
    const capabilityVersion = requireNonEmptyString(capability.version, "capability.version");
    const provider = asRecord(record.provider);
    if (provider === undefined) throw invalid("provider must be an object");
    const pluginId = requireNonEmptyString(provider.pluginId, "provider.pluginId");
    const authorKeyId = requirePrefixedSha256(provider.authorKeyId, "provider.authorKeyId");
    const parameters = cloneJsonObject(record.parameters, "parameters");
    const risk = requireRisk(record.risk, "risk");
    const grantRevision = requireNonNegativeInteger(record.grantRevision, "grantRevision");
    const requiresForegroundConfirmation = requireBoolean(
      record.requiresForegroundConfirmation,
      "requiresForegroundConfirmation",
    );
    const signal = record.signal;
    if (
      !(signal instanceof AbortSignal) &&
      !(
        typeof signal === "object" &&
        signal !== null &&
        typeof (signal as AbortSignal).aborted === "boolean" &&
        typeof (signal as AbortSignal).addEventListener === "function"
      )
    ) {
      throw invalid("signal must be an AbortSignal");
    }
    return {
      accountId,
      conversationId,
      deviceId,
      pairingGeneration,
      capability: Object.freeze({ id: capabilityId, version: capabilityVersion }),
      provider: Object.freeze({ pluginId, authorKeyId }),
      parameters,
      risk,
      grantRevision,
      requiresForegroundConfirmation,
      signal: signal as AbortSignal,
    };
  }

  #requestedPayload(record: DeviceRequestRecord): JsonObject {
    // 字段与 event.schema.json#/$defs/deviceRequestedEventPayload 完全一致。
    return deepFreeze({
      requestId: record.requestId,
      capability: { id: record.capability.id, version: record.capability.version },
      provider: {
        pluginId: record.provider.pluginId,
        authorKeyId: record.provider.authorKeyId,
      },
      parameters: record.parameters,
      risk: record.risk,
      grantRevision: record.grantRevision,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      requiresForegroundConfirmation: record.requiresForegroundConfirmation,
    });
  }

  #registerWaiter(
    accountId: string,
    record: DeviceRequestRecord,
    signal: AbortSignal,
  ): Promise<DeviceRequestRecord> {
    return new Promise<DeviceRequestRecord>((resolve) => {
      const onAbort = (): void => {
        try {
          this.#abort(accountId, record.requestId);
        } catch (error) {
          this.#warn("abort handling failed", error);
        }
      };
      // 到期即收敛：即使维护任务未运行，等待 Promise 也不会永久挂起。
      const delay = Math.max(0, Date.parse(record.expiresAt) - this.#nowMillis());
      const timer = setTimeout(() => {
        try {
          this.#expireOne(accountId, record.requestId);
        } catch (error) {
          this.#warn("scheduled expiry failed", error);
        }
      }, delay);
      timer.unref?.();
      const waiter: Waiter = {
        accountId,
        requestId: record.requestId,
        initial: record,
        resolve,
        timer,
        signal,
        onAbort,
      };
      this.#waiters.set(record.requestId, waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ---------------------------------------------------------------------------
  // claim / result
  // ---------------------------------------------------------------------------

  claim(request: VerifiedRequest, requestId: string, grantRevision: number): ClaimReceipt {
    this.#assertOpen();
    if (!isWireId(requestId)) throw invalid("requestId must be a wire ID");
    requireNonNegativeInteger(grantRevision, "grantRevision");
    const store = this.#store(request.accountId);
    let record = this.#requireRecord(store, requestId);
    this.#assertDeviceBinding(record, request);
    record = this.#expireIfDue(store, record);

    if (record.claimId !== null) {
      // 幂等重试：同一请求、同一设备、同一 generation/revision 返回同一 receipt。
      this.#assertRevision(record, grantRevision);
      return this.#receiptOf(record, request.accountId);
    }
    this.#assertRevision(record, grantRevision);
    if (record.state !== "pending") {
      // 交给纯 reducer 抛出契约规定的 INVALID_STATE_TRANSITION。
      nextDeviceRequestState(record.state, "claim");
      throw new Error("INVALID_STATE_TRANSITION");
    }
    const claimId = createWireId("claim_");
    try {
      record = store.transition(requestId, "pending", {
        state: "claimed",
        claimId,
        claimedAt: this.#nowIso(),
        updatedAt: this.#nowIso(),
      });
    } catch (error) {
      if (error instanceof DeviceRequestStateConflictError) {
        const latest = store.get(requestId);
        if (latest !== undefined && latest.claimId !== null) {
          this.#assertRevision(latest, grantRevision);
          return this.#receiptOf(latest, request.accountId);
        }
        nextDeviceRequestState(latest?.state ?? record.state, "claim");
      }
      throw error;
    }
    return this.#receiptOf(record, request.accountId);
  }

  submitResult(
    request: VerifiedRequest,
    requestId: string,
    body: DeviceRequestResultBody,
  ): DeviceRequestRecord {
    this.#assertOpen();
    if (!isWireId(requestId)) throw invalid("requestId must be a wire ID");
    const bodyRecord = asRecord(body);
    if (bodyRecord === undefined) throw invalid("result body must be an object");
    for (const key of Object.keys(bodyRecord)) {
      if (!RESULT_BODY_KEYS.has(key)) throw invalid(`result body contains unknown field ${key}`);
    }
    const claimId = requireNonEmptyString(bodyRecord.claimId, "claimId");
    if (!isWireId(claimId)) throw invalid("claimId must be a wire ID");
    const submittedRevision = requireNonNegativeInteger(bodyRecord.grantRevision, "grantRevision");
    const result = this.#validateResult(bodyRecord.result);
    const outcome = result.outcome as DeviceRequestOutcome;

    const store = this.#store(request.accountId);
    let record = this.#requireRecord(store, requestId);
    this.#assertDeviceBinding(record, request);
    record = this.#expireIfDue(store, record);
    if (record.claimId === null) {
      // 未 claim 的请求不能直接提交普通结果。
      nextDeviceRequestState(record.state, RESULT_EVENTS[outcome]);
      throw new Error("INVALID_STATE_TRANSITION");
    }
    if (record.claimId !== claimId) {
      throw new GatewayError("CAPABILITY_UNAVAILABLE", "Claim receipt does not match the request", {
        httpStatus: 403,
        details: { requestId },
      });
    }
    this.#assertRevision(record, submittedRevision);

    if (isTerminal(record.state)) {
      return this.#terminalIdempotent(record, result);
    }

    const event = RESULT_EVENTS[outcome];
    const nextState = nextDeviceRequestState(record.state, event);
    try {
      record = store.transition(requestId, record.state, {
        state: nextState,
        result,
        errorCode: this.#errorCodeOf(result),
        settledAt: this.#nowIso(),
        updatedAt: this.#nowIso(),
      });
    } catch (error) {
      if (error instanceof DeviceRequestStateConflictError) {
        const latest = store.get(requestId);
        if (latest !== undefined) {
          if (isTerminal(latest.state)) return this.#terminalIdempotent(latest, result);
          nextDeviceRequestState(latest.state, event);
        }
      }
      throw error;
    }
    this.#settle(record);
    return record;
  }

  #terminalIdempotent(record: DeviceRequestRecord, result: JsonObject): DeviceRequestRecord {
    const outcome = result.outcome as DeviceRequestOutcome;
    if (record.state === outcome) {
      if (record.result === null) return record;
      if (jsonEquals(record.result, result)) return record;
      throw new GatewayError(
        "IDEMPOTENCY_CONFLICT",
        "The request already reached a different terminal result",
        { details: { requestId: record.requestId, state: record.state } },
      );
    }
    if (record.state === "outcome_unknown") {
      throw new GatewayError(
        "OUTCOME_UNKNOWN",
        "The request outcome is unknown and cannot be overwritten",
        { details: { requestId: record.requestId } },
      );
    }
    throw new GatewayError(
      "IDEMPOTENCY_CONFLICT",
      "The request already reached a different terminal result",
      { details: { requestId: record.requestId, state: record.state } },
    );
  }

  #validateResult(value: unknown): JsonObject {
    const result = asRecord(value);
    if (result === undefined) throw invalid("result must be an object");
    for (const key of Object.keys(result)) {
      if (!RESULT_KEYS.has(key)) throw invalid(`result contains unknown field ${key}`);
    }
    const outcome = requireNonEmptyString(result.outcome, "result.outcome");
    if (!OUTCOME_VALUES.includes(outcome as DeviceRequestOutcome)) {
      throw invalid("result.outcome is not a known outcome");
    }
    const typedOutcome = outcome as DeviceRequestOutcome;
    if (result.data !== undefined) {
      if (typedOutcome === "outcome_unknown") {
        throw invalid("result.outcome_unknown must not carry data");
      }
      const data = cloneJsonObject(result.data, "result.data");
      return deepFreeze({ outcome: typedOutcome, data });
    }
    return deepFreeze({ outcome: typedOutcome });
  }

  #errorCodeOf(result: JsonObject): string | null {
    const data = asRecord(result.data);
    const code = data?.code;
    if (typeof code === "string" && code.length > 0 && code.length <= 128) return code;
    return null;
  }

  /** 已终态请求再次提交结果的幂等判断；`result` 是完整的 `{outcome,data?}`。 */
  #assertDeviceBinding(record: DeviceRequestRecord, request: VerifiedRequest): void {
    if (record.deviceId !== request.deviceId) {
      throw new GatewayError("CAPABILITY_UNAVAILABLE", "Unknown device request", {
        httpStatus: 404,
      });
    }
    if (record.pairingGeneration !== request.device.pairingGeneration) {
      throw new GatewayError(
        "PAIRING_GENERATION_STALE",
        "The request was created under an older pairing generation",
        {
          httpStatus: 409,
          details: {
            requestPairingGeneration: record.pairingGeneration,
            currentPairingGeneration: request.device.pairingGeneration,
          },
        },
      );
    }
  }

  #assertRevision(record: DeviceRequestRecord, grantRevision: number): void {
    if (record.grantRevision !== grantRevision) {
      throw new GatewayError("GRANT_STALE", "The request was created under a different grant revision", {
        httpStatus: 409,
        details: {
          requestGrantRevision: record.grantRevision,
          submittedGrantRevision: grantRevision,
        },
      });
    }
  }

  #requireRecord(store: DeviceRequestStore, requestId: string): DeviceRequestRecord {
    const record = store.get(requestId);
    if (record === undefined) {
      throw new GatewayError("CAPABILITY_UNAVAILABLE", "Unknown device request", {
        httpStatus: 404,
      });
    }
    return record;
  }

  #receiptOf(record: DeviceRequestRecord, accountId: string): ClaimReceipt {
    if (record.claimId === null) throw new Error("CLAIM_ID_MISSING");
    return Object.freeze({
      claimId: record.claimId,
      requestId: record.requestId,
      accountId,
      deviceId: record.deviceId,
      pairingGeneration: record.pairingGeneration,
      grantRevision: record.grantRevision,
    });
  }

  // ---------------------------------------------------------------------------
  // 查询、取消与过期
  // ---------------------------------------------------------------------------

  detail(request: VerifiedRequest, requestId: string): JsonObject {
    this.#assertOpen();
    if (!isWireId(requestId)) throw invalid("requestId must be a wire ID");
    const store = this.#store(request.accountId);
    let record = this.#requireRecord(store, requestId);
    // 同一账号内也按设备隔离：只有目标设备能读取请求详情。
    if (record.deviceId !== request.deviceId) {
      throw new GatewayError("CAPABILITY_UNAVAILABLE", "Unknown device request", {
        httpStatus: 404,
      });
    }
    record = this.#expireIfDue(store, record);
    // App 依赖 deviceId / pairingGeneration / grantRevision / state / expiresAt；
    // 这里返回的外壳与字段集合保持稳定，不夹带内部审计列。
    return {
      request: {
        requestId: record.requestId,
        capability: { id: record.capability.id, version: record.capability.version },
        provider: {
          pluginId: record.provider.pluginId,
          authorKeyId: record.provider.authorKeyId,
        },
        parameters: record.parameters,
        risk: record.risk,
        grantRevision: record.grantRevision,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        requiresForegroundConfirmation: record.requiresForegroundConfirmation,
        deviceId: record.deviceId,
        pairingGeneration: record.pairingGeneration,
        state: record.state,
      },
    };
  }

  pendingForDevice(accountId: string, deviceId: string): readonly string[] {
    this.#assertOpen();
    if (!isWireId(accountId)) throw invalid("accountId must be a wire ID");
    if (!isWireId(deviceId)) throw invalid("deviceId must be a wire ID");
    const store = this.#store(accountId);
    this.#expireAllDue(store);
    return store.listPendingForDevice(deviceId);
  }

  /**
   * 取消一个请求（取消意图，不伪造设备已经停止）。
   *
   * - pending → cancelled（终态，Promise 立即 resolve）；
   * - claimed → cancel_requested（等待可信 result 决定最终状态，Promise 继续等待）；
   * - 其余状态非法，抛 `INVALID_STATE_TRANSITION`。
   */
  cancel(accountId: string, requestId: string): void {
    this.#assertOpen();
    if (!isWireId(accountId)) throw invalid("accountId must be a wire ID");
    if (!isWireId(requestId)) throw invalid("requestId must be a wire ID");
    const store = this.#store(accountId);
    const record = this.#requireRecord(store, requestId);
    this.#cancelWith(store, accountId, record, false);
  }

  #cancelWith(
    store: DeviceRequestStore,
    accountId: string,
    record: DeviceRequestRecord,
    settleAlways: boolean,
  ): DeviceRequestRecord {
    const current = this.#expireIfDue(store, record);
    if (!isActive(current.state)) {
      // 交给纯 reducer 抛出 INVALID_STATE_TRANSITION。
      nextDeviceRequestState(current.state, "cancel");
      throw new Error("INVALID_STATE_TRANSITION");
    }
    this.#emit(accountId, DEVICE_CANCEL_REQUESTED_EVENT, { requestId: current.requestId });
    let updated: DeviceRequestRecord;
    try {
      const nextState = nextDeviceRequestState(current.state, "cancel");
      updated = store.transition(current.requestId, current.state, {
        state: nextState,
        settledAt: isTerminal(nextState) ? this.#nowIso() : undefined,
        updatedAt: this.#nowIso(),
      });
    } catch (error) {
      if (error instanceof DeviceRequestStateConflictError) {
        const latest = store.get(current.requestId);
        if (latest === undefined) throw error;
        if (settleAlways || isTerminal(latest.state)) this.#settle(latest);
        return latest;
      }
      throw error;
    }
    // 取消未 claim 的请求会直接进入终态；已 claim 的只进入 cancel_requested，
    // 但调用方中止（settleAlways）时必须 resolve 当前记录，避免工具挂起。
    if (settleAlways || isTerminal(updated.state)) this.#settle(updated);
    return updated;
  }

  /** AbortSignal 中止路径：先发取消意图事件，再迁移状态并 resolve 当前记录。 */
  #abort(accountId: string, requestId: string): void {
    const store = this.#store(accountId);
    const record = store.get(requestId);
    if (record === undefined) {
      const waiter = this.#waiters.get(requestId);
      if (waiter !== undefined) {
        this.#waiters.delete(requestId);
        this.#detach(waiter);
        waiter.resolve(waiter.initial);
      }
      return;
    }
    if (!isActive(record.state)) {
      this.#settle(record);
      return;
    }
    this.#cancelWith(store, accountId, record, true);
  }

  expireDue(accountId: string, now?: string): number {
    this.#assertOpen();
    if (!isWireId(accountId)) throw invalid("accountId must be a wire ID");
    const at = now ?? this.#nowIso();
    if (!UTC_MILLIS_PATTERN.test(at)) {
      throw invalid("now must be an RFC 3339 UTC millis timestamp");
    }
    const store = this.#store(accountId);
    const due = store.listExpired(at);
    let expired = 0;
    for (const record of due) {
      try {
        this.#applyExpire(store, record);
        expired += 1;
      } catch (error) {
        this.#warn(`device request expiry failed for ${record.requestId}`, error);
      }
    }
    return expired;
  }

  #expireAllDue(store: DeviceRequestStore): number {
    const due = store.listExpired(this.#nowIso());
    let expired = 0;
    for (const record of due) {
      try {
        this.#applyExpire(store, record);
        expired += 1;
      } catch (error) {
        this.#warn(`device request expiry failed for ${record.requestId}`, error);
      }
    }
    return expired;
  }

  #expireOne(accountId: string, requestId: string): void {
    const store = this.#store(accountId);
    const record = store.get(requestId);
    if (record === undefined) return;
    this.#applyExpire(store, record);
  }

  #expireIfDue(store: DeviceRequestStore, record: DeviceRequestRecord): DeviceRequestRecord {
    if (!isActive(record.state)) return record;
    if (record.expiresAt > this.#nowIso()) return record;
    return this.#applyExpire(store, record);
  }

  /** 按契约状态机推进过期：pending→expired；claimed/cancel_requested→outcome_unknown。 */
  #applyExpire(store: DeviceRequestStore, record: DeviceRequestRecord): DeviceRequestRecord {
    if (!isActive(record.state)) return record;
    let updated: DeviceRequestRecord;
    try {
      const nextState = nextDeviceRequestState(record.state, "expire");
      updated = store.transition(record.requestId, record.state, {
        state: nextState,
        errorCode: nextState === "outcome_unknown" ? "OUTCOME_UNKNOWN" : "REQUEST_EXPIRED",
        settledAt: this.#nowIso(),
        updatedAt: this.#nowIso(),
      });
    } catch (error) {
      if (error instanceof DeviceRequestStateConflictError) {
        const latest = store.get(record.requestId);
        if (latest === undefined) throw error;
        if (!isActive(latest.state)) this.#settle(latest);
        return latest;
      }
      throw error;
    }
    this.#settle(updated);
    return updated;
  }
}

/** 便于测试与 Lead 直接构造（与 `DeviceRequestStore` 组合使用）。 */
export const createDeviceCapabilityService = (
  options: DeviceCapabilityServiceOptions,
): DeviceCapabilityService => new DeviceCapabilityService(options);
