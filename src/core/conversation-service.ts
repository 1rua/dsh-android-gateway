import canonicalize from "canonicalize";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

import type { DshBridge, DshBridgeEvent } from "../dsh/bridge.js";
import { textOfBlocks } from "../dsh/bridge.js";
import type { DshAssistantStreamFrame, DshMessage, DshSessionEvent } from "../dsh/types.js";
import { GatewayError } from "../shared/errors.js";
import { createWireId, nowIso } from "../shared/ids.js";
import type {
  ConversationRecord,
  DeviceRecord,
  EventRecord,
  JsonObject,
  JsonValue,
  MessagePart,
  MessageRecord,
  OrganizationRecord,
  VerifiedRequest,
} from "../shared/types.js";
import { validateGatewayValue } from "../protocol/index.js";
import type { AccountStore } from "../store/contract.js";
import type { AccountManager } from "./accounts.js";
import type { AttachmentService } from "./attachment-service.js";
import type { GatewayEventHub } from "./event-hub.js";

const WIRE_ID = /^[A-Za-z0-9._~-]{1,128}$/;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const IMAGE_BLOCK = new Set(["image", "file"]);

interface PendingSend {
  readonly messageId: string;
  readonly clientMessageId: string;
  readonly generationId: string;
  readonly deviceId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly timestamp: number;
}

interface Draft {
  readonly messageId: string;
  text: string;
  revision: number;
  step: number;
  readonly startedAt: number;
}

interface ActiveGeneration {
  readonly generationId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly leader: PendingSend;
  state: "queued" | "running";
  readonly startedAt: number;
  draft: Draft | undefined;
  step: number;
  delivered: boolean;
}

interface ConversationRuntime {
  readonly queue: PendingSend[];
  active: ActiveGeneration | undefined;
  currentStep: number;
}

export interface ConversationServiceOptions {
  readonly accounts: AccountManager;
  readonly events: GatewayEventHub;
  readonly bridge: DshBridge;
  readonly attachments: AttachmentService;
  readonly workspace?: string;
  readonly logger?: { info(message: string): void; warn(message: string): void; error(message: string): void };
  readonly now?: () => number;
}

const toWireId = (prefix: string, raw: string): string => {
  if (WIRE_ID.test(raw) && raw.length <= 128) return raw;
  // DSH 消息 ID 可能不是 wire-safe：用 SHA-256 前 40 位作为稳定替代。
  return `${prefix}${createHash("sha256").update(raw).digest("hex").slice(0, 40)}`;
};

/**
 * 会话与生成引擎。
 *
 * 把 App 的 conversation/message 模型映射到 DSH Session：
 * - 会话创建走 `sessionController.create`，标题走 `rename`；
 * - 消息发送走 `prompt`（冷会话自动恢复）；
 * - 流式正文来自 `agent/assistant-stream`，最终正文与状态来自 `session/event`；
 * - 历史优先从 DSH surface 投影，消息账本只补 Gateway 自己的 ID/状态/幂等。
 */
export class ConversationService {
  readonly #options: ConversationServiceOptions;
  readonly #now: () => number;
  readonly #runtimes = new Map<string, ConversationRuntime>();
  readonly #sessionToConversation = new Map<string, string>();
  #unsubscribe: (() => void) | undefined;

  constructor(options: ConversationServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  start(): void {
    this.#unsubscribe ??= this.#options.bridge.subscribe((event) => {
      void this.#onBridgeEvent(event).catch((error) => {
        this.#options.logger?.warn(
          `[dsh-android-gateway] bridge event handling failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  #store(accountId: string): AccountStore {
    const store = this.#options.accounts.openStore(accountId);
    if (store === undefined) throw new GatewayError("ACCOUNT_NOT_FOUND", "Unknown account");
    return store;
  }

  #runtime(conversationId: string): ConversationRuntime {
    let runtime = this.#runtimes.get(conversationId);
    if (runtime === undefined) {
      runtime = { queue: [], active: undefined, currentStep: 0 };
      this.#runtimes.set(conversationId, runtime);
    }
    return runtime;
  }

  async #emit(
    accountId: string,
    type: string,
    payload: JsonObject,
    correlationId: string,
  ): Promise<EventRecord> {
    return this.#options.events.publish(accountId, {
      type,
      payload,
      correlationId,
    });
  }

  // ───────────────────────────── 会话 CRUD ─────────────────────────────

  async createConversation(
    request: VerifiedRequest,
    body: JsonObject | null,
  ): Promise<JsonObject> {
    if (body === null) throw new GatewayError("SCHEMA_INVALID", "Missing conversation body");
    const validation = validateGatewayValue("conversation.create", body);
    if (!validation.ok) throw new GatewayError("SCHEMA_INVALID", "Conversation create body does not match the contract");
    const clientConversationId = String(body.clientConversationId);
    const requestedTitle = typeof body.title === "string" ? body.title : null;
    const store = this.#store(request.accountId);
    const existing = store.findConversationByClientId(clientConversationId);
    if (existing !== undefined) {
      if (requestedTitle !== null && existing.title !== null && existing.title !== requestedTitle) {
        throw new GatewayError("IDEMPOTENCY_CONFLICT", "clientConversationId was reused with a different title");
      }
      return { conversation: this.#conversationDetail(existing) };
    }
    const now = this.#now();
    const conversationId = createWireId("conv_");
    const sessionId = await this.#options.bridge.createSession({
      sessionId: conversationId,
      ...(this.#options.workspace === undefined ? {} : { cwd: this.#options.workspace }),
    });
    const record = store.insertConversation({
      conversationId,
      clientConversationId,
      dshSessionId: sessionId,
      title: requestedTitle,
      createdAt: nowIso(new Date(now)),
      updatedAt: nowIso(new Date(now)),
    });
    this.#sessionToConversation.set(sessionId, conversationId);
    return { conversation: this.#conversationDetail(record) };
  }

  listConversations(request: VerifiedRequest, query: URLSearchParams): JsonObject {
    const store = this.#store(request.accountId);
    const recordLimit = query.get("limit");
    let limit = DEFAULT_PAGE_LIMIT;
    if (recordLimit !== null) {
      if (!/^[0-9]+$/.test(recordLimit)) throw new GatewayError("SCHEMA_INVALID", "Invalid limit");
      limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Number.parseInt(recordLimit, 10)));
    }
    const cursor = query.get("cursor");
    let offset = 0;
    if (cursor !== null) {
      if (!/^c[0-9]+$/.test(cursor)) throw new GatewayError("SCHEMA_INVALID", "Invalid cursor");
      offset = Number.parseInt(cursor.slice(1), 10);
    }
    const conversations = store
      .listConversations()
      .filter((conversation) => !conversation.deleted)
      .sort((left, right) => {
        const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
        return byUpdated !== 0 ? byUpdated : left.conversationId.localeCompare(right.conversationId);
      });
    const page = conversations.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      conversations: page.map((conversation) => this.#conversationSummary(conversation)),
      nextCursor: nextOffset < conversations.length ? `c${nextOffset}` : null,
      snapshotRevision: store.nextSnapshotRevision(),
    };
  }

  getConversation(request: VerifiedRequest, conversationId: string): JsonObject {
    const store = this.#store(request.accountId);
    const record = store.getConversation(conversationId);
    if (record === undefined || record.deleted) {
      throw new GatewayError("CONVERSATION_NOT_FOUND", "Unknown conversation");
    }
    return { conversation: this.#conversationDetail(record) };
  }

  async patchConversation(
    request: VerifiedRequest,
    conversationId: string,
    body: JsonObject | null,
  ): Promise<JsonObject> {
    if (body === null) throw new GatewayError("SCHEMA_INVALID", "Missing conversation patch body");
    const store = this.#store(request.accountId);
    const record = store.getConversation(conversationId);
    if (record === undefined || record.deleted) {
      throw new GatewayError("CONVERSATION_NOT_FOUND", "Unknown conversation");
    }
    if (typeof body.archived === "boolean") {
      if (body.archived === false && record.dshSessionId !== null) {
        await this.#options.bridge.setArchived(record.dshSessionId, false);
      } else if (body.archived === true && record.dshSessionId !== null) {
        await this.#options.bridge.setArchived(record.dshSessionId, true);
      }
      const updated = store.updateConversation(conversationId, {
        archived: body.archived,
        updatedAt: nowIso(),
      });
      await this.#emit(request.accountId, "conversation.updated", {
        conversationId,
        archived: body.archived,
      }, request.requestId);
      return {
        conversation: {
          ...this.#managedRecord(updated ?? record),
        },
      };
    }
    if (typeof body.title === "string") {
      const title = body.title.trim();
      if (title.length === 0) throw new GatewayError("SCHEMA_INVALID", "Title must not be empty");
      if (record.dshSessionId !== null) {
        await this.#options.bridge.rename(record.dshSessionId, title);
      }
      const updated = store.updateConversation(conversationId, {
        title,
        updatedAt: nowIso(),
      });
      await this.#emit(request.accountId, "conversation.title.updated", {
        conversationId,
        title,
        newTitle: title,
      }, request.requestId);
      return { conversation: this.#conversationDetail(updated ?? record) };
    }
    throw new GatewayError("SCHEMA_INVALID", "PATCH body must carry title or archived");
  }

  async deleteConversation(request: VerifiedRequest, conversationId: string): Promise<JsonObject> {
    const store = this.#store(request.accountId);
    const record = store.getConversation(conversationId);
    if (record === undefined || record.deleted) {
      throw new GatewayError("CONVERSATION_NOT_FOUND", "Unknown conversation");
    }
    const runtime = this.#runtimes.get(conversationId);
    if (runtime?.active !== undefined || (runtime?.queue.length ?? 0) > 0) {
      throw new GatewayError("CONVERSATION_BUSY", "Conversation still has pending generations", {
        httpStatus: 409,
      });
    }
    if (record.archived === false) {
      // 尽力归档；DSH 没有公开的 Session 删除 API，墓碑由网关保存。
      if (record.dshSessionId !== null) {
        await this.#options.bridge.setArchived(record.dshSessionId, true);
      }
    }
    store.updateConversation(conversationId, {
      deleted: true,
      archived: true,
      updatedAt: nowIso(),
    });
    this.#runtimes.delete(conversationId);
    await this.#emit(request.accountId, "conversation.updated", {
      conversationId,
      deleted: true,
    }, request.requestId);
    return { conversationId, deleted: true };
  }

  // ───────────────────────────── 消息发送 ─────────────────────────────

  async sendMessage(
    request: VerifiedRequest,
    conversationId: string,
    body: JsonObject | null,
  ): Promise<JsonObject> {
    if (body === null) throw new GatewayError("SCHEMA_INVALID", "Missing message body");
    const validation = validateGatewayValue("message.create", body);
    if (!validation.ok) throw new GatewayError("SCHEMA_INVALID", "Message body does not match the contract");
    const clientMessageId = String(body.clientMessageId);
    const text = typeof body.text === "string" ? body.text : "";
    const attachmentIds = Array.isArray(body.attachments)
      ? body.attachments.map((entry) => String((entry as JsonObject).attachmentId))
      : [];
    if (text.trim().length === 0 && attachmentIds.length === 0) {
      throw new GatewayError("SCHEMA_INVALID", "Message must carry text or attachments");
    }
    const store = this.#store(request.accountId);
    const conversation = store.getConversation(conversationId);
    if (conversation === undefined || conversation.deleted) {
      throw new GatewayError("CONVERSATION_NOT_FOUND", "Unknown conversation");
    }
    if (conversation.archived) {
      throw new GatewayError("CONVERSATION_ARCHIVED", "Conversation is archived", { httpStatus: 409 });
    }
    const existing = store.findMessageByClientId(conversationId, clientMessageId);
    if (existing !== undefined) {
      if (existing.text !== text) {
        throw new GatewayError("IDEMPOTENCY_CONFLICT", "clientMessageId was reused with different content");
      }
      return {
        message: {
          status: "accepted",
          messageId: existing.messageId,
          conversationId,
          ...(existing.generationId === null ? {} : { generationId: existing.generationId }),
        },
      };
    }
    if (conversation.dshSessionId === null) {
      throw new GatewayError("AGENT_UNAVAILABLE", "Conversation has no host session");
    }

    const now = this.#now();
    const messageId = createWireId("msg_");
    const generationId = createWireId("gen_");
    let prepared;
    try {
      prepared = await this.#options.attachments.prepareForPrompt(
        request,
        conversation.dshSessionId,
        attachmentIds,
      );
    } catch (error) {
      throw error;
    }
    const parts: MessagePart[] = [];
    if (text.length > 0) parts.push({ type: "text", text });
    for (const attachmentId of attachmentIds) {
      const record = store.getAttachment(attachmentId);
      if (record === undefined) continue;
      parts.push({
        type: "attachment",
        attachmentId,
        filename: record.filename,
        mediaType: record.mediaType,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
      });
    }
    const message = store.insertMessage({
      messageId,
      conversationId,
      clientMessageId,
      sender: "user",
      text,
      parts,
      status: "queued",
      revision: 0,
      errorCode: null,
      generationId,
      dshSeq: null,
      createdAt: nowIso(new Date(now)),
    });
    store.insertGeneration({
      generationId,
      conversationId,
      messageId,
      state: "queued",
      createdAt: nowIso(new Date(now)),
    });
    const runtime = this.#runtime(conversationId);
    runtime.queue.push({
      messageId,
      clientMessageId,
      generationId,
      deviceId: request.deviceId,
      text,
      attachmentIds,
      timestamp: now,
    });

    await this.#emit(request.accountId, "conversation.message.status", {
      conversationId,
      messageId,
      clientMessageId,
      status: "queued",
      revision: 0,
      errorCode: null,
      generationId,
    }, request.requestId);

    // 异步派发：接受响应只代表 Gateway 已持久接收（契约 §7）。
    void (async () => {
      try {
        await this.#options.bridge.prompt({
          sessionId: conversation.dshSessionId!,
          requestId: messageId,
          content: [
            ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
            ...prepared.parts,
          ],
        });
        this.#options.attachments.finishDelivery(request.accountId, prepared.deliveredIds);
      } catch (error) {
        this.#logDispatchFailure(conversationId, messageId, error);
        const errorCode = dispatchErrorCode(error);
        store.updateMessage(messageId, {
          status: "failed",
          revision: 1,
          errorCode,
          updatedAt: nowIso(),
        });
        store.updateGeneration(generationId, { state: "failed", endedAt: nowIso() });
        await this.#emit(request.accountId, "conversation.message.status", {
          conversationId,
          messageId,
          clientMessageId,
          status: "failed",
          revision: 1,
          errorCode,
          generationId,
        }, request.requestId).catch(() => undefined);
        this.#removeQueued(conversationId, messageId);
      }
    })();

    return {
      message: {
        status: "accepted",
        messageId,
        conversationId,
        generationId,
      },
    };
  }

  /** 把宿主拒绝原因写入账号目录下的受限诊断日志（不含消息正文与凭据）。 */
  #logDispatchFailure(conversationId: string, messageId: string, error: unknown): void {
    const record =
      typeof error === "object" && error !== null
        ? {
            name: (error as { name?: unknown }).name,
            code: (error as { code?: unknown }).code,
            message: (error as { message?: unknown }).message,
            details: (error as { details?: unknown }).details,
          }
        : { message: String(error) };
    const line = `${new Date().toISOString()}\t${conversationId}\t${messageId}\t${JSON.stringify(record)}\n`;
    try {
      const path = join(this.#options.accounts.rootDir, "diagnostics.log");
      appendFileSync(path, line, { mode: 0o600 });
      chmodSync(path, 0o600);
    } catch {
      // 诊断失败不得影响失败状态写入。
    }
    this.#options.logger?.warn(`[dsh-android-gateway] 消息派发失败: ${line.trim()}`);
  }

  #removeQueued(conversationId: string, messageId: string): void {
    const runtime = this.#runtimes.get(conversationId);
    if (runtime === undefined) return;
    const index = runtime.queue.findIndex((entry) => entry.messageId === messageId);
    if (index !== -1) runtime.queue.splice(index, 1);
  }

  currentGeneration(request: VerifiedRequest, conversationId: string): JsonObject {
    const store = this.#store(request.accountId);
    const conversation = store.getConversation(conversationId);
    if (conversation === undefined || conversation.deleted) {
      throw new GatewayError("CONVERSATION_NOT_FOUND", "Unknown conversation");
    }
    const runtime = this.#runtimes.get(conversationId);
    const active = runtime?.active;
    if (active === undefined) {
      const pending = runtime?.queue[0];
      if (pending === undefined) return { generation: null };
      return {
        generation: {
          conversationId,
          generationId: pending.generationId,
          state: "queued",
        },
      };
    }
    return {
      generation: {
        conversationId,
        generationId: active.generationId,
        state: active.state === "running" ? "running" : "queued",
      },
    };
  }

  async cancelGeneration(
    request: VerifiedRequest,
    conversationId: string,
    generationId: string,
    body: JsonObject | null,
  ): Promise<JsonObject> {
    if (body === null || typeof body.clientMessageId !== "string") {
      throw new GatewayError("SCHEMA_INVALID", "Cancel body must carry clientMessageId");
    }
    const store = this.#store(request.accountId);
    const conversation = store.getConversation(conversationId);
    if (conversation === undefined || conversation.deleted) {
      throw new GatewayError("CONVERSATION_NOT_FOUND", "Unknown conversation");
    }
    const runtime = this.#runtime(conversationId);
    const active = runtime.active;
    if (active === undefined || active.generationId !== generationId) {
      const generation = store.getGeneration(generationId);
      if (generation === undefined || generation.conversationId !== conversationId) {
        throw new GatewayError("SCHEMA_INVALID", "Unknown generation");
      }
      if (generation.state === "completed" || generation.state === "failed" || generation.state === "cancelled") {
        return { outcome: "ALREADY_COMPLETED", generationId };
      }
      return { outcome: "OUTCOME_UNKNOWN", generationId };
    }
    const accepted = this.#options.bridge.cancel(active.sessionId);
    if (!accepted) return { outcome: "UNSUPPORTED", generationId };
    store.updateGeneration(generationId, { state: "cancelled", endedAt: nowIso() });
    return { outcome: "CANCELLED", generationId };
  }

  // ───────────────────────────── 历史与命令 ─────────────────────────────

  async readMessages(
    request: VerifiedRequest,
    conversationId: string,
    query: URLSearchParams,
  ): Promise<JsonObject> {
    const store = this.#store(request.accountId);
    const conversation = store.getConversation(conversationId);
    if (conversation === undefined || conversation.deleted) {
      throw new GatewayError("CONVERSATION_NOT_FOUND", "Unknown conversation");
    }
    const clientMessageId = query.get("clientMessageId");
    if (clientMessageId !== null) {
      const message = store.findMessageByClientId(conversationId, clientMessageId);
      if (message === undefined) return { messages: [] };
      return {
        messages: [this.#timelineMessage(message)],
        nextCursor: null,
        snapshotRevision: store.nextSnapshotRevision(),
      };
    }
    const limitRaw = query.get("limit");
    let limit = DEFAULT_PAGE_LIMIT;
    if (limitRaw !== null) {
      if (!/^[0-9]+$/.test(limitRaw)) throw new GatewayError("SCHEMA_INVALID", "Invalid limit");
      limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Number.parseInt(limitRaw, 10)));
    }
    const cursor = query.get("cursor");
    let offset = 0;
    if (cursor !== null) {
      if (!/^c[0-9]+$/.test(cursor)) throw new GatewayError("SCHEMA_INVALID", "Invalid cursor");
      offset = Number.parseInt(cursor.slice(1), 10);
    }
    const messages = await this.#projectTimeline(request.accountId, conversation, store);
    const page = messages.slice(offset, offset + limit);
    return {
      messages: page,
      nextCursor: offset + page.length < messages.length ? `c${offset + page.length}` : null,
      snapshotRevision: store.nextSnapshotRevision(),
    };
  }

  async #projectTimeline(
    accountId: string,
    conversation: ConversationRecord,
    store: AccountStore,
  ): Promise<JsonObject[]> {
    const projected: JsonObject[] = [];
    const seenDshSeq = new Set<number>();
    if (conversation.dshSessionId !== null) {
      const surface = await this.#options.bridge.readSurface(conversation.dshSessionId);
      for (const event of surface?.events ?? []) {
        if (event.type !== "user/message" && event.type !== "assistant/message") continue;
        const data = event.data as { message?: DshMessage; turn?: number; step?: number };
        const message = data.message;
        if (message === undefined) continue;
        const stored = store.findMessageByDshSeq(conversation.conversationId, event.seq);
        if (stored !== undefined) {
          seenDshSeq.add(event.seq);
          projected.push(this.#timelineMessage(stored));
          continue;
        }
        const parts = this.#partsOfDshMessage(message);
        if (parts.length === 0 && message.role === "assistant") continue;
        if (message.role !== "user" && message.role !== "assistant") continue;
        projected.push({
          messageId: toWireId("msg_", message.id),
          sender: message.role,
          parts,
          text: textOfBlocks(message.content),
          timestamp: event.time,
          state: "CONFIRMED",
          ...(message.role === "user" ? {} : { contentRevision: 0 }),
        });
      }
    }
    // 尚未落到 DSH 日志的本地消息（queued/delivered/failed）也要可见。
    for (const message of store.listMessages(conversation.conversationId)) {
      if (message.dshSeq !== null && seenDshSeq.has(message.dshSeq)) continue;
      if (message.dshSeq !== null) continue;
      if (message.parts.length === 0 && message.text.length === 0) continue;
      projected.push(this.#timelineMessage(message));
    }
    projected.sort((left, right) => {
      const leftTime = Number(left.timestamp ?? 0);
      const rightTime = Number(right.timestamp ?? 0);
      if (leftTime !== rightTime) return leftTime - rightTime;
      return String(left.messageId).localeCompare(String(right.messageId));
    });
    return projected;
  }

  async commandCatalog(
    request: VerifiedRequest,
    query: URLSearchParams,
  ): Promise<JsonObject> {
    const store = this.#store(request.accountId);
    const requestedLanguage = query.get("languageCode");
    const languageCode = requestedLanguage !== null && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(requestedLanguage)
      ? requestedLanguage
      : "en";
    const conversation = store
      .listConversations()
      .find((entry) => !entry.deleted && entry.dshSessionId !== null);
    const descriptors =
      conversation === undefined || conversation.dshSessionId === null
        ? []
        : await this.#options.bridge.listCommands(conversation.dshSessionId);
    const commands = descriptors.map((descriptor) => {
      const invocation = `/${descriptor.name.replace(/^\/+/, "")}`;
      return {
        id: descriptor.name.replace(/^\/+/, ""),
        invocation,
        title: descriptor.name.replace(/^\/+/, ""),
        description: descriptor.description.length > 0 ? descriptor.description : invocation,
        acceptsArguments: descriptor.input !== undefined,
        availability: "available",
        ...(descriptor.input?.hint === undefined ? {} : { argumentHint: descriptor.input.hint }),
      };
    });
    const fingerprintSource =
      canonicalize({ format: "agent-command-catalog-1.0", commands }) ?? "{}";
    const catalogVersion = `cmdcat_${createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 16)}`;
    return {
      format: "agent-command-catalog-1.0",
      catalogVersion,
      languageCode,
      commands,
    };
  }

  // ───────────────────────────── 会话组织 ─────────────────────────────

  getOrganization(request: VerifiedRequest): JsonObject {
    const store = this.#store(request.accountId);
    const organization = store.getOrganization();
    return this.#organizationData(organization);
  }

  putOrganization(request: VerifiedRequest, body: JsonObject | null): JsonObject {
    if (body === null) throw new GatewayError("SCHEMA_INVALID", "Missing organization body");
    const validation = validateGatewayValue("conversation.organizationReplace", body);
    if (!validation.ok) throw new GatewayError("SCHEMA_INVALID", "Organization body does not match the contract");
    const expectedRevision = Number(body.expectedRevision);
    const store = this.#store(request.accountId);
    const conversation = store.getOrganization();
    if (expectedRevision !== conversation.revision) {
      throw new GatewayError("ORGANIZATION_CONFLICT", "Organization revision is stale", { httpStatus: 409 });
    }
    const folders = Array.isArray(body.folders)
      ? body.folders.map((entry) => {
          const folder = entry as JsonObject;
          return { folderId: String(folder.folderId), name: String(folder.name) };
        })
      : [];
    const assignments: Record<string, string> = {};
    if (typeof body.assignments === "object" && body.assignments !== null) {
      for (const [key, value] of Object.entries(body.assignments)) {
        assignments[key] = String(value);
      }
    }
    const updated = store.replaceOrganization(expectedRevision, {
      sortMode: body.sortMode === "custom" ? "custom" : "updated-desc",
      customOrder: Array.isArray(body.customOrder) ? body.customOrder.map(String) : [],
      folders,
      assignments,
    });
    void this.#emit(request.accountId, "conversation.organization.updated", {
      revision: updated.revision,
    }, request.requestId);
    return this.#organizationData(updated);
  }

  async syncSnapshot(request: VerifiedRequest): Promise<JsonObject> {
    const store = this.#store(request.accountId);
    const notice = await this.#emit(request.accountId, "gateway.notice", {
      noticeCode: "SYNC_BASELINE",
    }, request.requestId);
    const conversations = store
      .listConversations()
      .filter((conversation) => !conversation.deleted)
      .map((conversation) => ({
        conversationId: conversation.conversationId,
        clientConversationId: conversation.clientConversationId,
        title: conversation.title,
      }));
    return {
      baselineCursor: notice.eventId,
      conversations,
      pendingDeviceRequests: [],
      pairingGeneration: request.device.pairingGeneration,
      grantRevision: 1,
    };
  }

  #organizationData(organization: OrganizationRecord): JsonObject {
    return {
      revision: organization.revision,
      sortMode: organization.sortMode,
      customOrder: [...organization.customOrder],
      folders: organization.folders.map((folder) => ({ ...folder })),
      assignments: { ...organization.assignments },
    };
  }

  // ───────────────────────────── DSH 事件处理 ─────────────────────────────

  async #onBridgeEvent(event: DshBridgeEvent): Promise<void> {
    if (event.kind === "stream") {
      await this.#onStream(event.sessionId, event.frame);
      return;
    }
    if (event.kind === "status") {
      if (event.status === "idle") {
        // Agent 整体空闲：若仍有活跃生成但没有 turn/end（异常路径），结算它。
        await this.#settleRuntimeForSession(event.sessionId, "completed");
      }
      return;
    }
    if (event.kind === "error") {
      await this.#settleRuntimeForSession(event.sessionId, "failed");
      return;
    }
    await this.#onSessionEvent(event.sessionId, event.event);
  }

  #findAccountForSession(sessionId: string): { accountId: string; conversationId: string; store: AccountStore } | undefined {
    const known = this.#sessionToConversation.get(sessionId);
    if (known !== undefined) {
      const account = this.#options.accounts.registry.list().find((entry) => {
        const store = this.#options.accounts.openStore(entry.accountId);
        return store?.getConversation(known)?.dshSessionId === sessionId;
      });
      if (account !== undefined) {
        const store = this.#options.accounts.openStore(account.accountId);
        if (store !== undefined) return { accountId: account.accountId, conversationId: known, store };
      }
    }
    for (const account of this.#options.accounts.registry.list()) {
      const store = this.#options.accounts.openStore(account.accountId);
      if (store === undefined) continue;
      const conversation = store
        .listConversations()
        .find((entry) => entry.dshSessionId === sessionId && !entry.deleted);
      if (conversation !== undefined) {
        this.#sessionToConversation.set(sessionId, conversation.conversationId);
        return { accountId: account.accountId, conversationId: conversation.conversationId, store };
      }
    }
    return undefined;
  }

  async #onSessionEvent(sessionId: string, event: DshSessionEvent): Promise<void> {
    const found = this.#findAccountForSession(sessionId);
    if (found === undefined) return;
    const { accountId, conversationId, store } = found;
    const runtime = this.#runtime(conversationId);
    switch (event.type) {
      case "turn/start": {
        const pending = runtime.queue.shift();
        if (pending !== undefined) {
          runtime.active = {
            generationId: pending.generationId,
            conversationId,
            sessionId,
            leader: pending,
            state: "running",
            startedAt: this.#now(),
            draft: undefined,
            step: 0,
            delivered: false,
          };
          runtime.currentStep = 0;
          store.updateGeneration(pending.generationId, { state: "running" });
          this.#updateMessageStatus(
            store,
            accountId,
            conversationId,
            pending.messageId,
            "delivered",
            1,
            null,
            pending.generationId,
            null,
            event.time,
          );
        }
        break;
      }
      case "user/message": {
        const data = event.data as { message?: DshMessage };
        const message = data.message;
        if (message === undefined || message.role !== "user") break;
        // 优先把事件绑定到队列中的同文本消息；绑定失败则作为投影消息落库。
        const index = runtime.queue.findIndex((entry) => entry.text === textOfBlocks(message.content));
        const candidate = index === -1 ? undefined : runtime.queue[index];
        if (candidate !== undefined) {
          runtime.queue.splice(index, 1);
          store.updateMessage(candidate.messageId, { dshSeq: event.seq, updatedAt: nowIso(new Date(event.time)) });
        } else if (runtime.active !== undefined && !runtime.active.delivered) {
          const leader = runtime.active.leader;
          store.updateMessage(leader.messageId, { dshSeq: event.seq, updatedAt: nowIso(new Date(event.time)) });
          runtime.active.delivered = true;
        } else {
          const stored = store.findMessageByDshSeq(conversationId, event.seq);
          if (stored === undefined) {
            const parts = this.#partsOfDshMessage(message);
            store.insertMessage({
              messageId: toWireId("msg_", message.id),
              conversationId,
              clientMessageId: null,
              sender: "user",
              text: textOfBlocks(message.content),
              parts,
              status: "completed",
              revision: 0,
              errorCode: null,
              generationId: null,
              dshSeq: event.seq,
              createdAt: nowIso(new Date(event.time)),
            });
          }
        }
        store.updateConversation(conversationId, {
          lastMessageAt: nowIso(new Date(event.time)),
          updatedAt: nowIso(new Date(event.time)),
        });
        break;
      }
      case "step/start": {
        runtime.currentStep = Number((event.data as { step?: number }).step ?? 0);
        break;
      }
      case "assistant/message": {
        const data = event.data as { message?: DshMessage; step?: number; turn?: number };
        const message = data.message;
        if (message === undefined || message.role !== "assistant") break;
        const parts = this.#partsOfDshMessage(message);
        if (parts.length === 0) break;
        const active = runtime.active;
        const draft = active?.draft;
        const step = Number(data.step ?? 0);
        const messageId = draft !== undefined && draft.step === step
          ? draft.messageId
          : toWireId("msg_", message.id);
        const existing = store.getMessage(messageId);
        const text = textOfBlocks(message.content);
        const record = existing !== undefined
          ? store.updateMessage(messageId, {
              text,
              parts,
              status: "completed",
              revision: (existing.revision + 1),
              dshSeq: event.seq,
              updatedAt: nowIso(new Date(event.time)),
            })
          : store.insertMessage({
              messageId,
              conversationId,
              clientMessageId: null,
              sender: "assistant",
              text,
              parts,
              status: "completed",
              revision: 0,
              errorCode: null,
              generationId: active?.generationId ?? null,
              dshSeq: event.seq,
              createdAt: nowIso(new Date(event.time)),
            });
        if (active !== undefined) active.draft = undefined;
        await this.#emit(accountId, "conversation.message.completed", {
          conversationId,
          messageId: record?.messageId ?? messageId,
          sender: "assistant",
          parts: (record?.parts ?? parts) as unknown as JsonValue,
          text: record?.text ?? text,
          timestamp: event.time,
          revision: record?.revision ?? 0,
          ...(active === undefined ? {} : { generationId: active.generationId }),
        }, eventSeqCorrelation(conversationId, event.seq));
        store.updateConversation(conversationId, {
          lastMessageAt: nowIso(new Date(event.time)),
          updatedAt: nowIso(new Date(event.time)),
        });
        break;
      }
      case "turn/end": {
        const reason = (event.data as { reason?: { kind?: string } }).reason;
        const kind = reason?.kind ?? "completed";
        const active = runtime.active;
        if (active !== undefined) {
          const failed = kind === "error";
          const cancelled = kind === "aborted";
          const message = store.getMessage(active.leader.messageId);
          const nextStatus = failed ? "failed" : "completed";
          const errorCode = failed ? "MODEL_REQUEST_REJECTED" : null;
          this.#updateMessageStatus(
            store,
            accountId,
            conversationId,
            active.leader.messageId,
            nextStatus,
            (message?.revision ?? 0) + 1,
            errorCode,
            active.generationId,
            null,
            event.time,
          );
          store.updateGeneration(active.generationId, {
            state: failed ? "failed" : cancelled ? "cancelled" : "completed",
            endedAt: nowIso(new Date(event.time)),
          });
          runtime.active = undefined;
        }
        store.updateConversation(conversationId, { updatedAt: nowIso(new Date(event.time)) });
        // turn 结束后若仍有排队消息，等待下一次 turn/start。
        break;
      }
      default:
        break;
    }
  }

  async #onStream(sessionId: string, frame: DshAssistantStreamFrame): Promise<void> {
    if (frame.type !== "chunk") return;
    const chunk = frame.chunk;
    if (chunk.type !== "text-delta") return;
    const found = this.#findAccountForSession(sessionId);
    if (found === undefined) return;
    const { accountId, conversationId, store } = found;
    const runtime = this.#runtime(conversationId);
    const active = runtime.active;
    if (active === undefined) return;
    const step = runtime.currentStep;
    if (active.draft === undefined || active.draft.step !== step) {
      active.draft = {
        messageId: createWireId("msg_"),
        text: "",
        revision: 0,
        step,
        startedAt: this.#now(),
      };
    }
    const draft = active.draft;
    draft.text += chunk.text;
    draft.revision += 1;
    const timestamp = this.#now();
    this.#upsertDraft(store, conversationId, active, draft, timestamp);
    await this.#emit(accountId, "conversation.message.delta", {
      conversationId,
      messageId: draft.messageId,
      sender: "assistant",
      parts: [{ type: "text", text: draft.text }],
      text: draft.text,
      timestamp,
      revision: draft.revision,
      generationId: active.generationId,
    }, draft.messageId);
  }

  #upsertDraft(
    store: AccountStore,
    conversationId: string,
    active: ActiveGeneration,
    draft: Draft,
    timestamp: number,
  ): void {
    const existing = store.getMessage(draft.messageId);
    if (existing === undefined) {
      store.insertMessage({
        messageId: draft.messageId,
        conversationId,
        clientMessageId: null,
        sender: "assistant",
        text: draft.text,
        parts: [{ type: "text", text: draft.text }],
        status: "completed",
        revision: draft.revision,
        errorCode: null,
        generationId: active.generationId,
        dshSeq: null,
        createdAt: nowIso(new Date(timestamp)),
      });
    } else {
      store.updateMessage(draft.messageId, {
        text: draft.text,
        parts: [{ type: "text", text: draft.text }],
        revision: draft.revision,
        updatedAt: nowIso(new Date(timestamp)),
      });
    }
  }

  async #settleRuntimeForSession(sessionId: string, outcome: "completed" | "failed"): Promise<void> {
    const found = this.#findAccountForSession(sessionId);
    if (found === undefined) return;
    const { accountId, conversationId, store } = found;
    const runtime = this.#runtimes.get(conversationId);
    const active = runtime?.active;
    if (active === undefined) return;
    const message = store.getMessage(active.leader.messageId);
    this.#updateMessageStatus(
      store,
      accountId,
      conversationId,
      active.leader.messageId,
      outcome === "failed" ? "failed" : "completed",
      (message?.revision ?? 0) + 1,
      outcome === "failed" ? "MODEL_REQUEST_REJECTED" : null,
      active.generationId,
      null,
      this.#now(),
    );
    store.updateGeneration(active.generationId, {
      state: outcome === "failed" ? "failed" : "completed",
      endedAt: nowIso(),
    });
    runtime!.active = undefined;
  }

  #updateMessageStatus(
    store: AccountStore,
    accountId: string,
    conversationId: string,
    messageId: string,
    status: "queued" | "delivered" | "completed" | "failed",
    revision: number,
    errorCode: string | null,
    generationId: string | null,
    dshSeq: number | null,
    eventTime: number,
  ): void {
    const patch: Parameters<AccountStore["updateMessage"]>[1] = {
      status,
      revision,
      errorCode,
      updatedAt: nowIso(new Date(eventTime)),
      ...(dshSeq === null ? {} : { dshSeq }),
    };
    const updated = store.updateMessage(messageId, patch);
    if (updated === undefined) return;
    void this.#emit(accountId, "conversation.message.status", {
      conversationId,
      messageId: updated.messageId,
      clientMessageId: updated.clientMessageId ?? updated.messageId,
      status,
      revision,
      errorCode,
      ...(generationId === null ? {} : { generationId }),
    }, `${messageId}_${revision}`);
  }

  // ───────────────────────────── 类型转换 ─────────────────────────────

  #partsOfDshMessage(message: DshMessage): MessagePart[] {
    const parts: MessagePart[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text.length > 0) {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        parts.push({
          type: "attachment",
          attachmentId: block.attachment.attachmentId,
          mediaType: block.attachment.mediaType,
          sizeBytes: block.attachment.bytes,
          ...(block.attachment.name === undefined ? {} : { filename: block.attachment.name }),
        });
      } else if (block.type === "file") {
        parts.push({
          type: "attachment",
          attachmentId: block.attachment.attachmentId,
          filename: block.attachment.name,
          sizeBytes: block.attachment.bytes,
        });
      }
    }
    return parts;
  }

  #timelineMessage(message: MessageRecord): JsonObject {
    return {
      messageId: message.messageId,
      sender: message.sender,
      parts: message.parts as unknown as JsonValue,
      text: message.text,
      timestamp: Date.parse(message.createdAt),
      state: message.status,
      ...(message.clientMessageId === null ? {} : { clientMessageId: message.clientMessageId }),
      contentRevision: message.revision,
      ...(message.generationId === null ? {} : { generationId: message.generationId }),
    };
  }

  #conversationSummary(conversation: ConversationRecord): JsonObject {
    return {
      conversationId: conversation.conversationId,
      clientConversationId: conversation.clientConversationId,
      title: conversation.title,
      archived: conversation.archived,
      updatedAt: conversation.updatedAt,
      ...(conversation.lastMessageAt === null ? {} : { lastMessageAt: conversation.lastMessageAt }),
    };
  }

  #managedRecord(conversation: ConversationRecord): JsonObject {
    return {
      conversationId: conversation.conversationId,
      clientConversationId: conversation.clientConversationId,
      title: conversation.title,
      archived: conversation.archived,
      updatedAt: conversation.updatedAt,
    };
  }

  #conversationDetail(conversation: ConversationRecord): JsonObject {
    return {
      conversationId: conversation.conversationId,
      clientConversationId: conversation.clientConversationId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      snapshotRevision: 1,
    };
  }
}

const eventSeqCorrelation = (conversationId: string, seq: number): string =>
  `${conversationId}_${seq}`;

/**
 * 把宿主拒绝原因映射到契约 §9 的失败码闭集。
 *
 * `session/attachment-invalid` 表示宿主无法接纳图片/文件（例如损坏的 PNG、
 * 模型不支持图片输入），对应 `AGENT_MEDIA_REJECTED`；其余附件读取/存储失败
 * 是 `ATTACHMENT_READ_FAILED`；会话忙或模型请求被拒是 `MODEL_REQUEST_REJECTED`。
 */
const dispatchErrorCode = (error: unknown): string => {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = typeof record.code === "string" ? record.code : "";
  const message = typeof record.message === "string" ? record.message : "";
  const reason =
    typeof record.details === "object" && record.details !== null
      ? String((record.details as Record<string, unknown>).reason ?? "")
      : "";
  if (
    code === "session/attachment-invalid" ||
    /INVALID_IMAGE|IMAGE_|MODEL_DOES_NOT_SUPPORT_IMAGES/i.test(reason) ||
    /image|media/i.test(message)
  ) {
    return "AGENT_MEDIA_REJECTED";
  }
  if (/attachment/i.test(code) || /attachment/i.test(reason) || /attachment/i.test(message)) {
    return "ATTACHMENT_READ_FAILED";
  }
  if (code === "session/agent-busy" || /busy|model/i.test(message) || /model/i.test(reason)) {
    return "MODEL_REQUEST_REJECTED";
  }
  return "AGENT_UNAVAILABLE";
};
