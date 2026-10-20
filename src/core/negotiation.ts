import { GatewayError } from "../shared/errors.js";
import { nowIso } from "../shared/ids.js";
import type { JsonObject, NegotiationRequest } from "../shared/types.js";
import { CORE_SCHEMA_HASH, validateGatewayValue } from "../protocol/index.js";

/** 本实现真实提供的基础能力（契约 §4）。 */
export const SUPPORTED_MESSAGES = "chat-v1";
export const SUPPORTED_ATTACHMENTS = "staged-sha256-v1";
export const SUPPORTED_EVENTS = "sse-cursor-v1";
export const SUPPORTED_DEVICE_REQUESTS = "risk-queue-v1";

/** 本实现真实提供的对话面能力；未列出的能力绝不声明。 */
export const SUPPORTED_CONVERSATION_UI = [
  "agent-command-catalog-v1",
  "agent-command-new-v1",
  "agent-approval-cards-v1",
  "message-batches-v1",
  "newline-v1",
  "generation-cancel-v1",
  "conversation-management-v1",
] as const;

/** auth 方法：密码、刷新、邀请配对、设备密钥会话。 */
export const SUPPORTED_AUTH = ["password", "refresh", "account-invitation", "device-key"] as const;

const CONVERSATION_UI_CLOSED_SET = new Set([
  "agent-command-catalog-v1",
  "agent-command-new-v1",
  "agent-approval-cards-v1",
  "message-batches-v1",
  "newline-v1",
  "generation-cancel-v1",
  "conversation-mirror-v1",
  "attachment-status-v1",
  "conversation-management-v1",
]);

const AUTH_CLOSED_SET = new Set(["password", "account-invitation", "refresh", "device-key"]);

export interface PendingNegotiation {
  readonly negotiationId: string;
  readonly installationId: string;
  readonly appVersion: string;
  readonly schemaHash: string;
  readonly agreedConversationUi: readonly string[];
  readonly agreedAuth: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface NegotiationLimits {
  readonly attachmentTtlSeconds: number;
  readonly eventRetentionSeconds: number;
  readonly maxClockSkewSeconds: number;
}

export interface NegotiationManagerOptions {
  readonly deploymentId: () => string;
  readonly limits: NegotiationLimits;
  readonly tlsSpkiSha256?: string | null;
  readonly logger?: { warn(message: string): void };
  readonly now?: () => number;
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const intersection = (requested: readonly string[], supported: readonly string[]): string[] => {
  const supportedSet = new Set(supported);
  return [...new Set(requested)].filter((item) => supportedSet.has(item));
};

/**
 * 协商状态：`POST /negotiate` 的成功结果按 `negotiationId` 绑定后续密码登录，
 * 并在 TTL 内保留。协商失败从不留下状态。
 */
export class NegotiationManager {
  readonly #options: NegotiationManagerOptions;
  readonly #pending = new Map<string, PendingNegotiation>();
  readonly #now: () => number;
  static readonly TTL_MS = 24 * 60 * 60 * 1000; // 24h：覆盖一次连接内的刷新，不无限保留。

  constructor(options: NegotiationManagerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  get limits(): NegotiationLimits {
    return this.#options.limits;
  }

  /** 校验请求、计算交集、返回响应 data；失败抛契约错误。 */
  negotiate(json: JsonObject | null, requestId: string): { data: JsonObject; correlationId: string } {
    if (json === null) throw new GatewayError("SCHEMA_INVALID", "Missing negotiate body");
    const validation = validateGatewayValue("negotiate.request", json);
    if (!validation.ok) {
      throw new GatewayError("SCHEMA_INVALID", "Negotiate request does not match the contract", {
        details: { errors: validation.errors.length },
      });
    }
    const request = json as unknown as NegotiationRequest;
    if (request.protocol.major !== 2) {
      throw new GatewayError("PROTOCOL_INCOMPATIBLE", "Unsupported protocol major", {
        details: { expectedMajor: 2, receivedMajor: request.protocol.major },
      });
    }
    if (
      request.client.platform !== "android" ||
      typeof request.client.installationId !== "string"
    ) {
      throw new GatewayError("SCHEMA_INVALID", "Unsupported client identity");
    }

    const requestedCore = request.schemaHashes?.core;
    if (requestedCore !== CORE_SCHEMA_HASH) {
      const short = (value: unknown): string =>
        typeof value === "string" && value.startsWith("sha256:")
          ? `${value.slice(0, 15)}…`
          : "missing";
      this.#options.logger?.warn(
        `[dsh-android-gateway] 协商被拒绝：核心 Schema 摘要不一致 客户端=${short(
          requestedCore,
        )} 服务端=${short(CORE_SCHEMA_HASH)} installationId=${request.client.installationId} appVersion=${request.client.appVersion}`,
      );
      throw new GatewayError("PROTOCOL_INCOMPATIBLE", "Core schema hash mismatch", {
        details: {
          expected: CORE_SCHEMA_HASH.slice(0, 15),
          received: short(requestedCore),
        },
      });
    }

    const features = request.features;
    const required = [
      ["messages", features.messages, SUPPORTED_MESSAGES],
      ["attachments", features.attachments, SUPPORTED_ATTACHMENTS],
      ["events", features.events, SUPPORTED_EVENTS],
      ["deviceRequests", features.deviceRequests, SUPPORTED_DEVICE_REQUESTS],
    ] as const;
    for (const [name, requested, supported] of required) {
      if (!Array.isArray(requested) || !requested.includes(supported)) {
        throw new GatewayError("PROTOCOL_INCOMPATIBLE", `Client does not declare required ${name}`);
      }
    }

    const requestedAuth = asStringArray(features.auth);
    if (!requestedAuth.every((entry) => AUTH_CLOSED_SET.has(entry))) {
      throw new GatewayError("SCHEMA_INVALID", "Unknown auth feature");
    }
    const requestedUi = asStringArray(features.conversationUi ?? []);
    if (!requestedUi.every((entry) => CONVERSATION_UI_CLOSED_SET.has(entry))) {
      throw new GatewayError("SCHEMA_INVALID", "Unknown conversationUi feature");
    }

    const agreedAuth = intersection(requestedAuth, SUPPORTED_AUTH);
    const agreedConversationUi = intersection(requestedUi, SUPPORTED_CONVERSATION_UI);
    const now = this.#now();
    this.#prune(now);

    const pending: PendingNegotiation = {
      negotiationId: request.negotiationId,
      installationId: request.client.installationId,
      appVersion: request.client.appVersion,
      schemaHash: request.schemaHashes.core,
      agreedConversationUi,
      agreedAuth,
      createdAt: now,
      expiresAt: now + NegotiationManager.TTL_MS,
    };
    this.#pending.set(pending.negotiationId, pending);

    const data: JsonObject = {
      protocol: { major: 2, minor: 1 },
      features: {
        auth: [...agreedAuth],
        messages: SUPPORTED_MESSAGES,
        attachments: SUPPORTED_ATTACHMENTS,
        events: SUPPORTED_EVENTS,
        deviceRequests: SUPPORTED_DEVICE_REQUESTS,
        conversationUi: [...agreedConversationUi],
      },
      limits: {
        attachmentTtlSeconds: this.#options.limits.attachmentTtlSeconds,
        eventRetentionSeconds: this.#options.limits.eventRetentionSeconds,
        maxClockSkewSeconds: this.#options.limits.maxClockSkewSeconds,
        // message-batches-v1：契约限定成员数与聚合字节上限。
        maxBatchMembers: 20,
        maxBatchBytes: 65_536,
      },
      gatewayIdentity: {
        deploymentId: this.#options.deploymentId(),
        tlsSpkiSha256: this.#options.tlsSpkiSha256 ?? null,
      },
    };
    const responseValidation = validateGatewayValue("negotiate.response", data);
    if (!responseValidation.ok) {
      throw new GatewayError("INTERNAL_ERROR", "Negotiate response failed schema validation");
    }
    return { data, correlationId: request.negotiationId };
  }

  /**
   * 取回协商结果。
   * @param requireInstallation 密码登录必须与协商时声明的安装一致。
   */
  get(negotiationId: string, installationId: string | undefined): PendingNegotiation | undefined {
    this.#prune(this.#now());
    const pending = this.#pending.get(negotiationId);
    if (pending === undefined) return undefined;
    if (installationId !== undefined && pending.installationId !== installationId) return undefined;
    return pending;
  }

  /** 刷新路径：协商过期时按安装绑定宽限（凭证本身仍绑定设备与安装）。 */
  getForRefresh(negotiationId: string, installationId: string): PendingNegotiation | undefined {
    const pending = this.get(negotiationId, installationId);
    return pending;
  }

  #prune(now: number): void {
    for (const [id, pending] of this.#pending) {
      if (pending.expiresAt <= now) this.#pending.delete(id);
    }
  }

  describe(negotiationId: string): string {
    const pending = this.#pending.get(negotiationId);
    return pending === undefined ? "absent" : `installation=${pending.installationId} at=${nowIso(new Date(pending.createdAt))}`;
  }
}
