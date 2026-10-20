import { GatewayError } from "../shared/errors.js";
import type { JsonObject } from "../shared/types.js";
import type {
  CapabilityPublication,
  CapabilityRisk,
  DeviceCapabilityServiceApi,
  DeviceRequestRecord,
  PublishedCapabilityBinding,
} from "./contract.js";

/** 工具执行上下文只依赖 DSH 的最小结构，不 import DSH 具体类型。 */
export interface DeviceToolExecution {
  readonly agent?: {
    readonly session?: {
      readonly id?: string | number;
    };
  };
  readonly signal?: AbortSignal;
}

/** 由调用方注入：Agent 会话 → Gateway 账号 + 会话映射。 */
export interface DeviceToolContext {
  readonly accountId: string;
  readonly conversationId: string;
}

/** 由调用方注入：账号当前有效设备、配对代次与授权 revision。 */
export interface DeviceToolDevice {
  readonly deviceId: string;
  readonly pairingGeneration: number;
  readonly grantRevision: number;
}

export type MaybePromise<T> = T | Promise<T>;

export interface CreateDeviceToolsOptions {
  readonly service: DeviceCapabilityServiceApi;
  readonly resolveContext: (
    agentSessionId: string,
  ) => MaybePromise<DeviceToolContext | undefined | null>;
  readonly resolveDevice: (
    accountId: string,
  ) => MaybePromise<DeviceToolDevice | undefined | null>;
}

export interface DeviceToolTextBlock {
  readonly type: "text";
  readonly text: string;
}

/**
 * 普通对象工具定义，可直接交给 `agent.ctx.tools.register(def)`。
 *
 * 注意：注册表不校验 arguments，因此 `execute` 自己完成参数校验并返回结构化错误。
 */
export interface DeviceToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>;
    render(args: unknown, value: unknown): readonly DeviceToolTextBlock[];
  };
  execute(args: unknown, exec: DeviceToolExecution): Promise<JsonObject>;
}

export interface DeviceTools {
  readonly capabilities: DeviceToolDefinition;
  readonly device: DeviceToolDefinition;
}

const RISK_VALUES: readonly CapabilityRisk[] = [
  "read",
  "sync",
  "write",
  "high-privilege-ephemeral",
];

/** 工具失败原因（结构化、可供模型判断，不伪造设备结果）。 */
const FAILURE_REASONS = [
  "REQUEST_INVALID",
  "AGENT_SESSION_UNAVAILABLE",
  "ACCOUNT_UNAVAILABLE",
  "CAPABILITY_DENIED",
  "DEVICE_UNAVAILABLE",
  "QUEUE_REJECTED",
  "PARAMETERS_INVALID",
  "GRANT_STALE",
  "PAIRING_GENERATION_STALE",
  "REQUEST_EXPIRED",
  "REQUEST_ABORTED",
  "REQUEST_PENDING",
  "INTERNAL_ERROR",
] as const;

type FailureReason = (typeof FAILURE_REASONS)[number];

const OUTCOMES = ["succeeded", "failed", "denied", "cancelled", "outcome_unknown"] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textRender = (_args: unknown, value: unknown): readonly DeviceToolTextBlock[] => [
  { type: "text", text: JSON.stringify(value) },
];

const failure = (
  reason: FailureReason,
  message: string,
  extra?: JsonObject,
): JsonObject => ({
  reason,
  message,
  ...(extra ?? {}),
});

const failureFromError = (error: unknown): JsonObject => {
  if (error instanceof GatewayError) {
    switch (error.code) {
      case "SCHEMA_INVALID":
        return failure("PARAMETERS_INVALID", `参数校验失败：${error.message}`);
      case "CAPABILITY_UNAVAILABLE":
        return failure("QUEUE_REJECTED", `设备请求未进入队列：${error.message}`);
      case "GRANT_STALE":
        return failure("GRANT_STALE", "请求使用的授权 revision 已过期，请重新发布能力。");
      case "PAIRING_GENERATION_STALE":
        return failure("PAIRING_GENERATION_STALE", "请求的配对代次已过期，请重新配对。");
      case "OUTCOME_UNKNOWN":
        return failure("QUEUE_REJECTED", "设备结果未知，不能再次提交普通结果。");
      case "IDEMPOTENCY_CONFLICT":
        return failure("INTERNAL_ERROR", "同一请求已产生不同的终态结果。");
      default:
        return failure("INTERNAL_ERROR", error.message);
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    return failure("REQUEST_ABORTED", "工具调用已被取消。");
  }
  return failure("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
};

const sessionIdOf = (exec: DeviceToolExecution): string | undefined => {
  const id = exec?.agent?.session?.id;
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return undefined;
};

const compareVersions = (left: string, right: string): number => {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? "0";
    const rightPart = rightParts[index] ?? "0";
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
    if (leftNumber === undefined || rightNumber === undefined) {
      const compared = leftPart.localeCompare(rightPart);
      if (compared !== 0) return compared;
    }
  }
  return 0;
};

/** 按 capability id（可选版本）选择绑定；省略版本时取最高版本。 */
const findBinding = (
  publication: CapabilityPublication,
  capabilityId: string,
  capabilityVersion: string | undefined,
): PublishedCapabilityBinding | undefined => {
  const candidates = publication.bindings.filter(
    (binding) => binding.capabilityId === capabilityId,
  );
  if (capabilityVersion !== undefined) {
    return candidates.find((binding) => binding.capabilityVersion === capabilityVersion);
  }
  return [...candidates].sort((left, right) =>
    compareVersions(right.capabilityVersion, left.capabilityVersion),
  )[0];
};

const describeBindings = (publication: CapabilityPublication): string[] =>
  publication.bindings.map(
    (binding) => `${binding.capabilityId}@${binding.capabilityVersion} (${binding.risk})`,
  );

const outcomeOf = (
  record: DeviceRequestRecord,
): (typeof OUTCOMES)[number] | undefined => {
  switch (record.state) {
    case "succeeded":
    case "failed":
    case "denied":
    case "cancelled":
    case "outcome_unknown":
      return record.state;
    default:
      return undefined;
  }
};

const dataOf = (record: DeviceRequestRecord): JsonObject | undefined => {
  if (!isPlainObject(record.result)) return undefined;
  const data = record.result.data;
  return isPlainObject(data) ? (data as JsonObject) : undefined;
};

/** 把终态记录投影成工具 canonical 输出；非终态只如实说明状态，不编造结果。 */
const resultOfRecord = (record: DeviceRequestRecord): JsonObject => {
  const outcome = outcomeOf(record);
  if (outcome !== undefined) {
    const data = dataOf(record);
    return {
      requestId: record.requestId,
      outcome,
      ...(data === undefined ? {} : { data }),
      ...(record.errorCode === null ? {} : { errorCode: record.errorCode }),
    };
  }
  if (record.state === "cancel_requested") {
    // 已 claim 后取消：设备可能仍在执行，唯一诚实的结论是 outcome unknown。
    return {
      requestId: record.requestId,
      outcome: "outcome_unknown",
      errorCode: "CANCEL_REQUESTED",
    };
  }
  if (record.state === "expired") {
    return failure("REQUEST_EXPIRED", "设备请求在排队期内未被领取，已过期。", {
      requestId: record.requestId,
    });
  }
  return failure("REQUEST_PENDING", "设备请求仍在等待设备处理。", {
    requestId: record.requestId,
  });
};

const capabilitiesOutputSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: ["available", "capabilities", "inventory", "diagnostics"],
  properties: {
    available: { type: "boolean" },
    capabilities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "pluginId",
          "authorKeyId",
          "capabilityId",
          "capabilityVersion",
          "risk",
          "schema",
        ],
        properties: {
          pluginId: { type: "string" },
          authorKeyId: { type: "string" },
          capabilityId: { type: "string" },
          capabilityVersion: { type: "string" },
          risk: { type: "string", enum: RISK_VALUES },
          schema: { type: "object", additionalProperties: true },
        },
      },
    },
    inventory: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pluginId", "capabilityId", "capabilityVersion", "status", "reason"],
        properties: {
          pluginId: { type: "string" },
          capabilityId: { type: "string" },
          capabilityVersion: { type: "string" },
          status: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    diagnostics: { type: "array", items: { type: "string" } },
  },
};

const deviceOutputSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  properties: {
    requestId: { type: "string" },
    outcome: { type: "string", enum: OUTCOMES },
    data: { type: "object", additionalProperties: true },
    errorCode: { type: "string" },
    reason: { type: "string", enum: FAILURE_REASONS },
    message: { type: "string" },
  },
};

/**
 * 构造两个模型工具：
 * - `open_android_capabilities`：让模型发现设备能力（无发布时 available=false + 诊断）；
 * - `open_android_device`：发起一次能力请求并等待终态，失败返回结构化 reason。
 *
 * 身份、设备、授权 revision 与风险级别全部由注入的 resolver 和已发布绑定补齐，
 * 模型只能提供 capability/version/parameters。
 */
export const createDeviceTools = (options: CreateDeviceToolsOptions): DeviceTools => {
  const capabilitiesTool: DeviceToolDefinition = {
    name: "open_android_capabilities",
    description:
      "发现已配对 Android 设备发布的能力绑定。返回能力 id/版本、风险级别、参数 Schema，以及设备本地能力清单（诊断用，不构成授权）。若设备尚未发布能力，available=false 并给出诊断。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeInventory: {
          type: "boolean",
          description: "是否包含设备本地能力清单（状态与不可用原因）。默认 false。",
        },
      },
      required: [],
    },
    output: { schema: capabilitiesOutputSchema, render: textRender },
    async execute(rawArgs, exec): Promise<JsonObject> {
      let includeInventory = false;
      if (rawArgs !== undefined && rawArgs !== null) {
        if (!isPlainObject(rawArgs)) {
          return {
            available: false,
            capabilities: [],
            inventory: [],
            diagnostics: ["参数必须是对象：{ includeInventory?: boolean }。"],
          };
        }
        const requested = rawArgs.includeInventory;
        if (requested !== undefined) {
          if (typeof requested !== "boolean") {
            return {
              available: false,
              capabilities: [],
              inventory: [],
              diagnostics: ["includeInventory 必须是布尔值。"],
            };
          }
          includeInventory = requested;
        }
      }

      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) {
        return {
          available: false,
          capabilities: [],
          inventory: [],
          diagnostics: ["无法从当前工具执行上下文取得 Agent 会话 ID。"],
        };
      }
      let context: DeviceToolContext | undefined | null;
      try {
        context = await options.resolveContext(sessionId);
      } catch (error) {
        return {
          available: false,
          capabilities: [],
          inventory: [],
          diagnostics: [`解析 Agent 会话归属失败：${error instanceof Error ? error.message : String(error)}`],
        };
      }
      if (context === undefined || context === null) {
        return {
          available: false,
          capabilities: [],
          inventory: [],
          diagnostics: ["当前 Agent 会话尚未绑定到 Gateway 账号。"],
        };
      }

      const publication = options.service.publication(context.accountId);
      if (publication === undefined) {
        return {
          available: false,
          capabilities: [],
          inventory: [],
          diagnostics: [
            "尚未收到 Android 设备的能力发布（POST /pairings/current/capabilities）。",
            "请在手机上完成插件授权并保持 Gateway 连接，待能力发布同步后重试。",
          ],
        };
      }

      const capabilities = publication.bindings.map((binding) => ({
        pluginId: binding.pluginId,
        authorKeyId: binding.authorKeyId,
        capabilityId: binding.capabilityId,
        capabilityVersion: binding.capabilityVersion,
        risk: binding.risk,
        schema: binding.schema,
      }));
      const diagnostics: string[] = [];
      if (capabilities.length === 0) {
        diagnostics.push("设备已发布能力清单，但没有任何 READY 绑定；请在手机上检查插件授权与本地权限。");
      } else {
        diagnostics.push(
          `已收到 ${capabilities.length} 个能力绑定（grantRevision=${publication.grantRevision}）。`,
        );
      }
      const unavailable = publication.inventory.filter((entry) => entry.status !== "READY");
      if (unavailable.length > 0) {
        diagnostics.push(
          `本地清单中有 ${unavailable.length} 个能力当前不可用，详见 inventory.status/reason。`,
        );
      }
      if (!includeInventory && publication.inventory.length > 0) {
        diagnostics.push(
          `未返回 ${publication.inventory.length} 条本地清单条目；如需查看请设置 includeInventory=true。`,
        );
      }

      return {
        available: capabilities.length > 0,
        capabilities,
        inventory: includeInventory
          ? publication.inventory.map((entry) => ({
              pluginId: entry.pluginId,
              capabilityId: entry.capabilityId,
              capabilityVersion: entry.capabilityVersion,
              status: entry.status,
              reason: entry.reason,
            }))
          : [],
        diagnostics,
      };
    },
  };

  const deviceTool: DeviceToolDefinition = {
    name: "open_android_device",
    description:
      "在已配对的 Android 设备上执行一个已发布的能力，并等待设备返回结果。capability 必须是 open_android_capabilities 返回的 capabilityId；parameters 必须符合该能力的参数 Schema。设备离线、能力未授权、队列拒绝或超时会返回结构化 reason，不会伪造执行结果。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["capability", "parameters"],
      properties: {
        capability: {
          type: "string",
          description: "能力 ID，例如 org.openandroidintelligence.sms.query。",
        },
        version: {
          type: "string",
          description: "可选能力版本；省略时使用已发布的最高版本。",
        },
        parameters: {
          type: "object",
          additionalProperties: true,
          description: "能力参数对象，必须符合该能力的参数 Schema。",
        },
      },
    },
    output: { schema: deviceOutputSchema, render: textRender },
    async execute(rawArgs, exec): Promise<JsonObject> {
      if (!isPlainObject(rawArgs)) {
        return failure("REQUEST_INVALID", "参数必须是对象：{ capability, version?, parameters }。");
      }
      const capability = rawArgs.capability;
      if (typeof capability !== "string" || capability.length === 0) {
        return failure("REQUEST_INVALID", "capability 必须是非空字符串。");
      }
      if (rawArgs.version !== undefined) {
        if (typeof rawArgs.version !== "string" || rawArgs.version.length === 0) {
          return failure("REQUEST_INVALID", "version 必须是非空字符串。");
        }
      }
      const version = typeof rawArgs.version === "string" ? rawArgs.version : undefined;
      if (!isPlainObject(rawArgs.parameters)) {
        return failure("REQUEST_INVALID", "parameters 必须是 JSON 对象。");
      }
      const parameters = rawArgs.parameters as JsonObject;
      let serializedParameters: string;
      try {
        serializedParameters = JSON.stringify(parameters);
      } catch {
        return failure("PARAMETERS_INVALID", "parameters 必须可序列化为 JSON。");
      }
      if (serializedParameters === undefined) {
        return failure("PARAMETERS_INVALID", "parameters 必须可序列化为 JSON。");
      }

      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) {
        return failure("AGENT_SESSION_UNAVAILABLE", "无法从当前工具执行上下文取得 Agent 会话 ID。");
      }
      let context: DeviceToolContext | undefined | null;
      try {
        context = await options.resolveContext(sessionId);
      } catch (error) {
        return failure(
          "ACCOUNT_UNAVAILABLE",
          `解析 Agent 会话归属失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (context === undefined || context === null) {
        return failure("ACCOUNT_UNAVAILABLE", "当前 Agent 会话尚未绑定到 Gateway 账号。");
      }
      if (exec.signal?.aborted === true) {
        return failure("REQUEST_ABORTED", "工具调用已被取消，未创建设备请求。");
      }

      const publication = options.service.publication(context.accountId);
      if (publication === undefined) {
        return failure(
          "CAPABILITY_DENIED",
          "尚未收到设备能力发布；请先在手机上完成插件授权与能力发布。",
        );
      }
      const binding = findBinding(publication, capability, version);
      if (binding === undefined) {
        return failure("CAPABILITY_DENIED", `没有匹配的能力绑定：${capability}${version === undefined ? "" : `@${version}`}。`, {
          availableCapabilities: describeBindings(publication),
        } as JsonObject);
      }

      let device: DeviceToolDevice | undefined | null;
      try {
        device = await options.resolveDevice(context.accountId);
      } catch (error) {
        return failure(
          "DEVICE_UNAVAILABLE",
          `解析设备失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (device === undefined || device === null) {
        return failure("DEVICE_UNAVAILABLE", "当前账号没有可用的已配对设备。");
      }

      const signal = exec.signal ?? new AbortController().signal;
      try {
        const record = await options.service.createRequest({
          accountId: context.accountId,
          conversationId: context.conversationId,
          device: {
            deviceId: device.deviceId,
            pairingGeneration: device.pairingGeneration,
          },
          capability: { id: binding.capabilityId, version: binding.capabilityVersion },
          provider: { pluginId: binding.pluginId, authorKeyId: binding.authorKeyId },
          parameters,
          risk: binding.risk,
          grantRevision: device.grantRevision,
          requiresForegroundConfirmation:
            binding.risk === "write" || binding.risk === "high-privilege-ephemeral",
          signal,
        });
        return resultOfRecord(record);
      } catch (error) {
        return failureFromError(error);
      }
    },
  };

  return Object.freeze({ capabilities: capabilitiesTool, device: deviceTool });
};
