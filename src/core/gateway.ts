import { createHash } from "node:crypto";

import { GatewayError } from "../shared/errors.js";
import type { GatewayResult, JsonObject, VerifiedRequest } from "../shared/types.js";
import type {
  AttachmentUploadFile,
  GatewayCore,
  RawGatewayRequest,
} from "../http/contract.js";
import type { AccountManager } from "./accounts.js";
import type { AttachmentService } from "./attachment-service.js";
import type { AuthService } from "./auth-service.js";
import type { ConversationService } from "./conversation-service.js";
import type { GatewayEventHub } from "./event-hub.js";
import type { NegotiationManager } from "./negotiation.js";
import type { PairingService } from "./pairing-service.js";

const MOUNT_PATH = "/open-android-intelligence/v2";
const WIRE_ID = /^[A-Za-z0-9._~-]{1,128}$/;

export interface AndroidGatewayOptions {
  readonly accounts: AccountManager;
  readonly negotiations: NegotiationManager;
  readonly auth: AuthService;
  readonly conversations: ConversationService;
  readonly attachments: AttachmentService;
  readonly pairing: PairingService;
  readonly events: GatewayEventHub;
  readonly logger?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  readonly now?: () => number;
}

const relativePath = (path: string): string => {
  if (path === MOUNT_PATH) return "/";
  if (!path.startsWith(`${MOUNT_PATH}/`)) {
    throw new GatewayError("SCHEMA_INVALID", "Unknown route", { httpStatus: 404 });
  }
  return path.slice(MOUNT_PATH.length);
};

const segments = (path: string): string[] =>
  path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeURIComponent);

const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * Gateway Protocol v2.1 业务入口。
 *
 * HTTP 层只处理传输；本类负责身份之外的协议语义：
 * 协商、账号绑定、会话/消息/生成、命令目录、附件、组织与快照，以及幂等账本。
 */
export class AndroidGatewayCore implements GatewayCore {
  readonly #options: AndroidGatewayOptions;
  readonly #now: () => number;

  constructor(options: AndroidGatewayOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  // ───────────────────────────── 预认证 ─────────────────────────────

  async negotiate(request: RawGatewayRequest): Promise<GatewayResult> {
    const result = this.#options.negotiations.negotiate(request.json, request.json === null ? "unparsed" : "");
    return { status: 200, data: result.data, correlationId: result.correlationId };
  }

  async passwordLogin(request: RawGatewayRequest): Promise<GatewayResult> {
    const result = await this.#options.auth.login(request.json);
    return { status: 200, data: result.data, correlationId: negotiationOf(request) };
  }

  async refresh(request: RawGatewayRequest): Promise<GatewayResult> {
    const result = this.#options.auth.refresh(request.json);
    return { status: 200, data: result.data, correlationId: negotiationOf(request) };
  }

  // ───────────────────────────── 已认证：登出/解绑 ─────────────────────────────

  async logout(request: VerifiedRequest): Promise<GatewayResult> {
    const revokeRefresh = request.query.get("revokeRefresh") === "true";
    const data = this.#options.auth.logout(request, revokeRefresh);
    return { status: 200, data };
  }

  // ───────────────────────────── 已认证：附件内容 ─────────────────────────────

  async uploadAttachmentContent(
    request: VerifiedRequest,
    upload: AttachmentUploadFile,
  ): Promise<GatewayResult> {
    const parts = segments(relativePath(request.path));
    if (parts.length !== 3 || parts[0] !== "attachments" || parts[1] === undefined || parts[2] !== "content") {
      throw new GatewayError("SCHEMA_INVALID", "Unknown attachment content route", { httpStatus: 404 });
    }
    const attachmentId = parts[1];
    if (!WIRE_ID.test(attachmentId)) throw new GatewayError("SCHEMA_INVALID", "Invalid attachment id");
    const fingerprint = sha256Hex(`${request.method}\n${request.path}\n${upload.sha256Hex}`);
    return this.#withIdempotency(request, fingerprint, async () => {
      const data = await this.#options.attachments.uploadContent(request, attachmentId, upload);
      return { status: 200, data };
    });
  }

  // ───────────────────────────── 已认证：分派 ─────────────────────────────

  async handle(request: VerifiedRequest): Promise<GatewayResult> {
    const path = relativePath(request.path);
    const parts = segments(path);
    const method = request.method;

    if (method !== "GET") {
      const fingerprint = sha256Hex(
        `${method}\n${path}\n${request.query.toString()}\n${request.bodyText}`,
      );
      return this.#withIdempotency(request, fingerprint, () => this.#dispatch(request, parts));
    }
    return this.#dispatch(request, parts);
  }

  async #dispatch(request: VerifiedRequest, parts: readonly string[]): Promise<GatewayResult> {
    const method = request.method;
    const [head, second, third, fourth, fifth] = parts;

    // /conversations
    if (head === "conversations" && second === undefined) {
      if (method === "GET") {
        return { status: 200, data: this.#options.conversations.listConversations(request, request.query) };
      }
      if (method === "POST") {
        return {
          status: 200,
          data: await this.#options.conversations.createConversation(request, request.json),
        };
      }
      throw new GatewayError("SCHEMA_INVALID", "Method not allowed", { httpStatus: 405 });
    }

    if (head === "conversations" && second !== undefined) {
      const conversationId = second;
      if (!WIRE_ID.test(conversationId)) throw new GatewayError("SCHEMA_INVALID", "Invalid conversation id");
      // /conversations/{id}
      if (third === undefined) {
        if (method === "GET") {
          return { status: 200, data: this.#options.conversations.getConversation(request, conversationId) };
        }
        if (method === "PATCH") {
          return {
            status: 200,
            data: await this.#options.conversations.patchConversation(
              request,
              conversationId,
              request.json,
            ),
          };
        }
        if (method === "DELETE") {
          return {
            status: 200,
            data: await this.#options.conversations.deleteConversation(request, conversationId),
          };
        }
        throw new GatewayError("SCHEMA_INVALID", "Method not allowed", { httpStatus: 405 });
      }
      // /conversations/{id}/messages
      if (third === "messages" && fourth === undefined) {
        if (method === "GET") {
          return {
            status: 200,
            data: await this.#options.conversations.readMessages(request, conversationId, request.query),
          };
        }
        if (method === "POST") {
          return {
            status: 200,
            data: await this.#options.conversations.sendMessage(request, conversationId, request.json),
          };
        }
        throw new GatewayError("SCHEMA_INVALID", "Method not allowed", { httpStatus: 405 });
      }
      // /conversations/{id}/generations/current
      if (third === "generations" && fourth === "current" && fifth === undefined) {
        if (method !== "GET") throw new GatewayError("SCHEMA_INVALID", "Method not allowed", { httpStatus: 405 });
        return { status: 200, data: this.#options.conversations.currentGeneration(request, conversationId) };
      }
      // /conversations/{id}/generations/{generationId}/cancel
      if (third === "generations" && fourth !== undefined && fifth === "cancel") {
        if (method !== "POST") throw new GatewayError("SCHEMA_INVALID", "Method not allowed", { httpStatus: 405 });
        if (!WIRE_ID.test(fourth)) throw new GatewayError("SCHEMA_INVALID", "Invalid generation id");
        return {
          status: 200,
          data: await this.#options.conversations.cancelGeneration(
            request,
            conversationId,
            fourth,
            request.json,
          ),
        };
      }
      // /conversations/{id}/message-batches（未声明能力）
      if (third === "message-batches") {
        throw new GatewayError("CAPABILITY_UNAVAILABLE", "Message batches are not implemented", {
          httpStatus: 501,
        });
      }
      // /conversations/{id}/attachments/{attachmentId}/metadata
      if (third === "attachments" && fourth !== undefined && fifth === "metadata" && method === "GET") {
        return {
          status: 200,
          data: this.#options.attachments.historyMetadata(request, conversationId, fourth),
        };
      }
      if (third === "attachments") {
        throw new GatewayError("CAPABILITY_UNAVAILABLE", "History media content is not implemented", {
          httpStatus: 501,
        });
      }
      throw new GatewayError("SCHEMA_INVALID", "Unknown route", { httpStatus: 404 });
    }

    // /commands
    if (head === "commands" && second === undefined && method === "GET") {
      return { status: 200, data: await this.#options.conversations.commandCatalog(request, request.query) };
    }

    // /conversation-organization
    if (head === "conversation-organization" && second === undefined) {
      if (method === "GET") {
        return { status: 200, data: this.#options.conversations.getOrganization(request) };
      }
      if (method === "PUT") {
        return { status: 200, data: this.#options.conversations.putOrganization(request, request.json) };
      }
      throw new GatewayError("SCHEMA_INVALID", "Method not allowed", { httpStatus: 405 });
    }

    // /sync/snapshot
    if (head === "sync" && second === "snapshot" && method === "GET") {
      const data = await this.#options.conversations.syncSnapshot(request);
      const pairing = this.#options.pairing.get(request);
      data.grantRevision = pairing.grantRevision as JsonObject[string];
      return { status: 200, data };
    }

    // /attachments
    if (head === "attachments" && second === undefined) {
      if (method === "POST") {
        return { status: 200, data: this.#options.attachments.create(request, request.json) };
      }
      throw new GatewayError("SCHEMA_INVALID", "Method not allowed", { httpStatus: 405 });
    }
    if (head === "attachments" && second !== undefined) {
      if (!WIRE_ID.test(second)) throw new GatewayError("SCHEMA_INVALID", "Invalid attachment id");
      if (third === undefined && method === "GET") {
        return { status: 200, data: this.#options.attachments.status(request, second) };
      }
      if (third === "commit" && method === "POST") {
        return { status: 200, data: this.#options.attachments.commit(request, second) };
      }
      throw new GatewayError("SCHEMA_INVALID", "Method not allowed", { httpStatus: 405 });
    }

    // /pairings/current 与 /pairings/current/capabilities
    if (head === "pairings" && second === "current") {
      if (third === undefined) {
        if (method === "GET") {
          return { status: 200, data: this.#options.pairing.get(request) };
        }
        if (method === "DELETE") {
          return { status: 200, data: this.#options.auth.unpair(request) };
        }
      }
      if (third === "capabilities" && method === "POST") {
        return {
          status: 200,
          data: await this.#options.pairing.publishCapabilities(request, request.json),
        };
      }
      throw new GatewayError("SCHEMA_INVALID", "Method not allowed", { httpStatus: 405 });
    }

    // 未实现/未协商的认证端点：明确返回能力不可用，而不是 404 混淆。
    if (
      (head === "sessions" && second !== "current") ||
      head === "pairings" ||
      head === "approvals" ||
      head === "device-requests" ||
      head === "events"
    ) {
      throw new GatewayError("CAPABILITY_UNAVAILABLE", "This endpoint is not implemented", {
        httpStatus: 501,
      });
    }

    throw new GatewayError("SCHEMA_INVALID", "Unknown route", { httpStatus: 404 });
  }

  // ───────────────────────────── 幂等账本 ─────────────────────────────

  async #withIdempotency(
    request: VerifiedRequest,
    fingerprint: string,
    task: () => Promise<GatewayResult> | GatewayResult,
  ): Promise<GatewayResult> {
    const store = this.#options.accounts.openStore(request.accountId);
    if (store === undefined) throw new GatewayError("ACCOUNT_NOT_FOUND", "Unknown account");
    const scope = `${request.accountId}:${request.deviceId}`;
    const prior = store.findIdempotency(scope, request.requestId);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        throw new GatewayError("IDEMPOTENCY_CONFLICT", "This request id was reused with different input");
      }
      const recorded = JSON.parse(prior.responseJson) as { status?: number; data?: JsonObject };
      return {
        status: typeof recorded.status === "number" ? recorded.status : 200,
        data: recorded.data ?? {},
      };
    }
    const result = await task();
    store.saveIdempotency({
      scope,
      requestId: request.requestId,
      fingerprint,
      responseJson: JSON.stringify({ status: result.status, data: result.data }),
      createdAt: new Date(this.#now()).toISOString(),
    });
    return result;
  }

  // ───────────────────────────── 后台维护 ─────────────────────────────

  /** 清理过期附件与事件；由插件定时器周期调用。 */
  maintenance(): { expiredAttachments: number } {
    let expired = 0;
    for (const account of this.#options.accounts.registry.list()) {
      try {
        expired += this.#options.attachments.expireDue(account.accountId);
      } catch (error) {
        this.#options.logger?.warn(
          `[dsh-android-gateway] attachment expiry failed for ${account.accountId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { expiredAttachments: expired };
  }
}

const negotiationOf = (request: RawGatewayRequest): string => {
  const json = request.json;
  if (json !== null && typeof json.negotiationId === "string") return json.negotiationId;
  return `req_${Date.now().toString(36)}`;
};

export { MOUNT_PATH };
