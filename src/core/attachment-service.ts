import { randomBytes } from "node:crypto";

import { GatewayError } from "../shared/errors.js";
import { createWireId, nowIso } from "../shared/ids.js";
import type { AttachmentRecord, AttachmentStatus, JsonObject, VerifiedRequest } from "../shared/types.js";
import type { AttachmentUploadFile } from "../http/contract.js";
import type { DshFileRef, DshImageRef, DshPromptPart } from "../dsh/types.js";
import { validateGatewayValue } from "../protocol/index.js";
import type { AccountStore } from "../store/contract.js";
import type { AccountManager } from "./accounts.js";
import { AttachmentStorage, fileStream } from "./attachment-storage.js";
import type { DshBridge } from "../dsh/bridge.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const PUBLIC_STATUS: Record<AttachmentStatus, "staged" | "uploaded" | "failed" | "expired"> = {
  staged: "staged",
  uploaded: "uploaded",
  failed: "failed",
  expired: "expired",
};

export interface AttachmentServiceOptions {
  readonly accounts: AccountManager;
  readonly bridge: DshBridge;
  readonly ttlSeconds: number;
  readonly maxBytes: number;
  readonly logger?: { warn(message: string): void; info(message: string): void };
  readonly now?: () => number;
}

interface CreateAttachmentBody {
  readonly clientAttachmentId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * 附件暂存：创建 → 上传字节 → 提交，以及发送消息时的宿主转交。
 * 公开状态只有 staged/uploaded/failed/expired（契约 §8）。
 */
/** DSH 附件引用以 JSON 存在 `dsh_attachment_id` 列：图片/文件的完整引用都能回读。 */
type StoredDshRef =
  | { readonly kind: "image"; readonly ref: DshImageRef }
  | { readonly kind: "file"; readonly ref: DshFileRef };

const encodeDshRef = (value: StoredDshRef): string => JSON.stringify(value);

const decodeDshRef = (value: string | null): StoredDshRef | undefined => {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as StoredDshRef;
    if (parsed.kind === "image" || parsed.kind === "file") return parsed;
  } catch {
    // 旧版本可能存过纯 attachmentId；无法回读时按不可用处理。
  }
  return undefined;
};

interface MediaGrant {
  readonly accountId: string;
  readonly conversationId: string;
  readonly attachmentId: string;
  readonly expiresAt: number;
}

export class AttachmentService {
  readonly #options: AttachmentServiceOptions;
  readonly #storages = new Map<string, AttachmentStorage>();
  readonly #grants = new Map<string, MediaGrant>();
  readonly #now: () => number;

  constructor(options: AttachmentServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  #store(accountId: string): AccountStore {
    const store = this.#options.accounts.openStore(accountId);
    if (store === undefined) throw new GatewayError("ACCOUNT_NOT_FOUND", "Unknown account");
    return store;
  }

  #storage(accountId: string): AttachmentStorage {
    let storage = this.#storages.get(accountId);
    if (storage === undefined) {
      storage = new AttachmentStorage({
        accountId,
        masterKey: this.#options.accounts.masterKey(accountId),
        directory: `${this.#options.accounts.accountDir(accountId)}/attachments`,
      });
      this.#storages.set(accountId, storage);
    }
    return storage;
  }

  #statusData(record: AttachmentRecord): JsonObject {
    return {
      attachment: {
        attachmentId: record.attachmentId,
        status: PUBLIC_STATUS[record.status],
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
      },
    };
  }

  create(verified: VerifiedRequest, json: JsonObject | null): JsonObject {
    if (json === null) throw new GatewayError("SCHEMA_INVALID", "Missing attachment body");
    const validation = validateGatewayValue("attachment.create", json);
    if (!validation.ok) throw new GatewayError("SCHEMA_INVALID", "Attachment create body does not match the contract");
    const body = json as unknown as CreateAttachmentBody;
    if (body.sizeBytes < 0 || !/^[0-9a-f]{64}$/.test(body.sha256)) {
      throw new GatewayError("SCHEMA_INVALID", "Attachment integrity metadata is invalid");
    }
    const store = this.#store(verified.accountId);
    const existing = store.findAttachmentByClientId(body.clientAttachmentId);
    if (existing !== undefined) {
      if (
        existing.filename !== body.filename ||
        existing.mediaType !== body.mediaType ||
        existing.sizeBytes !== body.sizeBytes ||
        existing.sha256 !== body.sha256
      ) {
        throw new GatewayError("IDEMPOTENCY_CONFLICT", "clientAttachmentId was reused with different metadata");
      }
      return this.#statusData(existing);
    }
    const now = this.#now();
    const record = store.insertAttachment({
      attachmentId: createWireId("att_"),
      clientAttachmentId: body.clientAttachmentId,
      filename: body.filename,
      mediaType: body.mediaType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      status: "staged",
      storagePath: null,
      createdAt: nowIso(new Date(now)),
      expiresAt: new Date(now + this.#options.ttlSeconds * 1000).toISOString(),
    });
    return this.#statusData(record);
  }

  async uploadContent(
    verified: VerifiedRequest,
    attachmentId: string,
    upload: AttachmentUploadFile,
  ): Promise<JsonObject> {
    const store = this.#store(verified.accountId);
    const record = store.getAttachment(attachmentId);
    if (record === undefined) throw new GatewayError("ATTACHMENT_EXPIRED", "Unknown attachment");
    if (record.status === "uploaded") {
      if (record.sha256 !== upload.sha256Hex || record.sizeBytes !== upload.contentLength) {
        throw new GatewayError("IDEMPOTENCY_CONFLICT", "Attachment content differs from the committed bytes");
      }
      return this.#statusData(record);
    }
    if (record.status === "expired" || record.status === "failed") {
      throw new GatewayError("ATTACHMENT_EXPIRED", "Attachment is no longer uploadable");
    }
    if (upload.contentLength !== record.sizeBytes) {
      throw new GatewayError("ATTACHMENT_DIGEST_MISMATCH", "Content-Length differs from the declared size");
    }
    if (upload.sha256Hex !== record.sha256) {
      throw new GatewayError("ATTACHMENT_DIGEST_MISMATCH", "Uploaded bytes do not match the declared digest");
    }
    if (upload.contentLength > this.#options.maxBytes) {
      throw new GatewayError("ATTACHMENT_STORAGE_UNAVAILABLE", "Attachment exceeds the configured staging limit");
    }
    const storage = this.#storage(verified.accountId);
    const stored = await storage.write(attachmentId, fileStream(upload.filePath));
    if (stored.sizeBytes !== record.sizeBytes || stored.sha256 !== record.sha256) {
      storage.remove(stored.storagePath);
      throw new GatewayError("ATTACHMENT_DIGEST_MISMATCH", "Stored bytes do not match the declared digest");
    }
    const updated = store.updateAttachment(attachmentId, {
      status: "uploaded",
      storagePath: stored.storagePath,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
    });
    return this.#statusData(updated ?? record);
  }

  commit(verified: VerifiedRequest, attachmentId: string): JsonObject {
    const store = this.#store(verified.accountId);
    const record = store.getAttachment(attachmentId);
    if (record === undefined) throw new GatewayError("ATTACHMENT_EXPIRED", "Unknown attachment");
    if (record.status === "uploaded") return this.#statusData(record);
    if (record.status === "staged") {
      throw new GatewayError("ATTACHMENT_STORAGE_UNAVAILABLE", "Attachment bytes have not been uploaded");
    }
    throw new GatewayError("ATTACHMENT_EXPIRED", "Attachment cannot be committed");
  }

  status(verified: VerifiedRequest, attachmentId: string): JsonObject {
    const store = this.#store(verified.accountId);
    const record = store.getAttachment(attachmentId);
    if (record === undefined) throw new GatewayError("ATTACHMENT_EXPIRED", "Unknown attachment");
    return this.#statusData(record);
  }

  /**
   * 历史媒体元数据（契约 §7 历史媒体节）。
   *
   * 宿主确认接收后网关会删除自己那份暂存字节（原件归宿主），因此这里如实返回
   * `remoteAvailable:false`：App 会展示附件信息并标记原件不可用，而不是拿到 501。
   */
  historyMetadata(
    verified: VerifiedRequest,
    conversationId: string,
    attachmentId: string,
  ): JsonObject {
    const store = this.#store(verified.accountId);
    const conversation = store.getConversation(conversationId);
    if (conversation === undefined || conversation.deleted) {
      throw new GatewayError("CONVERSATION_NOT_FOUND", "Unknown conversation");
    }
    const record = store.getAttachment(attachmentId);
    if (record === undefined) throw new GatewayError("ATTACHMENT_EXPIRED", "Unknown attachment");
    const message = store
      .listMessages(conversationId)
      .find((entry) => entry.parts.some((part) => part.type === "attachment" && part.attachmentId === attachmentId));
    return {
      metadata: {
        attachmentId,
        conversationId,
        ...(message === undefined ? {} : { messageId: message.messageId }),
        filename: record.filename,
        mediaType: record.mediaType,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
        remoteAvailable: decodeDshRef(record.dshAttachmentId) !== undefined,
        status: decodeDshRef(record.dshAttachmentId) === undefined ? "expired" : "uploaded",
        estimatedLocalBytes: 0,
      },
    };
  }

  /** 发送消息前检查附件并转换为 DSH prompt 内容块。 */
  async prepareForPrompt(
    verified: VerifiedRequest,
    sessionId: string,
    attachmentIds: readonly string[],
  ): Promise<{ parts: DshPromptPart[]; deliveredIds: string[] }> {
    const store = this.#store(verified.accountId);
    const storage = this.#storage(verified.accountId);
    const parts: DshPromptPart[] = [];
    const deliveredIds: string[] = [];
    for (const attachmentId of attachmentIds) {
      const record = store.getAttachment(attachmentId);
      if (record === undefined || record.status !== "uploaded" || record.storagePath === null) {
        throw new GatewayError("ATTACHMENT_EXPIRED", "Attachment is not available for sending");
      }
      const { bytes, sha256 } = await storage.readAll(record.storagePath, attachmentId);
      if (sha256 !== record.sha256) {
        throw new GatewayError("ATTACHMENT_DIGEST_MISMATCH", "Stored attachment bytes are corrupted");
      }
      if (IMAGE_TYPES.has(record.mediaType.toLowerCase())) {
        // 先落到宿主附件库，历史媒体才能按引用回读。
        const imageRef = await this.#options.bridge.saveImage(
          bytes,
          record.mediaType,
          record.filename,
        );
        if (imageRef === undefined) {
          throw new GatewayError("AGENT_MEDIA_REJECTED", "Host image storage is unavailable");
        }
        store.updateAttachment(attachmentId, {
          dshAttachmentId: encodeDshRef({ kind: "image", ref: imageRef }),
        });
        parts.push({
          type: "image",
          mediaType: record.mediaType,
          data: bytes.toString("base64"),
          name: record.filename,
        });
      } else {
        const uploaded = await this.#options.bridge.uploadFile(
          sessionId,
          (async function* () {
            yield bytes;
          })(),
          record.filename,
        );
        if (uploaded === undefined) {
          throw new GatewayError("ATTACHMENT_STORAGE_UNAVAILABLE", "Host file upload is unavailable");
        }
        store.updateAttachment(attachmentId, {
          dshAttachmentId: encodeDshRef({
            kind: "file",
            ref: { attachmentId: uploaded.attachmentId, name: record.filename, bytes: record.sizeBytes },
          }),
        });
        parts.push({ type: "file", receiptId: uploaded.receiptId });
      }
      deliveredIds.push(attachmentId);
    }
    return { parts, deliveredIds };
  }

  /** 历史媒体短期授权（契约 §7 历史媒体节）。 */
  cacheGrant(
    verified: VerifiedRequest,
    conversationId: string,
    attachmentId: string,
  ): JsonObject {
    const store = this.#store(verified.accountId);
    const conversation = store.getConversation(conversationId);
    if (conversation === undefined || conversation.deleted) {
      throw new GatewayError("CONVERSATION_NOT_FOUND", "Unknown conversation");
    }
    const record = store.getAttachment(attachmentId);
    if (record === undefined || decodeDshRef(record.dshAttachmentId) === undefined) {
      throw new GatewayError("ATTACHMENT_EXPIRED", "Attachment original is unavailable");
    }
    const grantId = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + 60_000;
    this.#grants.set(grantId, {
      accountId: verified.accountId,
      conversationId,
      attachmentId,
      expiresAt,
    });
    return { grantId, expiresAt: nowIso(new Date(expiresAt)) };
  }

  /** 历史媒体内容（JSON/Base64 旧外壳；App 兼容路径）。 */
  async mediaContent(
    verified: VerifiedRequest,
    conversationId: string,
    attachmentId: string,
    grantId: string | null,
  ): Promise<JsonObject> {
    if (grantId === null) throw new GatewayError("SCHEMA_INVALID", "grantId is required");
    const grant = this.#grants.get(grantId);
    if (
      grant === undefined ||
      grant.expiresAt <= this.#now() ||
      grant.accountId !== verified.accountId ||
      grant.conversationId !== conversationId ||
      grant.attachmentId !== attachmentId
    ) {
      throw new GatewayError("ATTACHMENT_EXPIRED", "Media grant is invalid or expired");
    }
    const store = this.#store(verified.accountId);
    const record = store.getAttachment(attachmentId);
    const stored = record === undefined ? undefined : decodeDshRef(record.dshAttachmentId);
    if (record === undefined || stored === undefined) {
      throw new GatewayError("ATTACHMENT_EXPIRED", "Attachment original is unavailable");
    }
    let bytes: Uint8Array;
    if (stored.kind === "image") {
      const data = await this.#options.bridge.readImage(stored.ref);
      if (data === undefined) throw new GatewayError("ATTACHMENT_EXPIRED", "Attachment original is unavailable");
      bytes = data;
    } else {
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of this.#options.bridge.readFile(stored.ref)) {
          chunks.push(Buffer.from(chunk));
        }
      } catch {
        throw new GatewayError("ATTACHMENT_EXPIRED", "Attachment original is unavailable");
      }
      bytes = Buffer.concat(chunks);
    }
    return {
      contentBase64: Buffer.from(bytes).toString("base64"),
      mediaType: record.mediaType,
    };
  }

  /** 宿主确认接收后删除暂存字节（契约 §8：保留无正文终态）。 */
  finishDelivery(accountId: string, attachmentIds: readonly string[]): void {
    const store = this.#options.accounts.openStore(accountId);
    if (store === undefined) return;
    const storage = this.#storage(accountId);
    for (const attachmentId of attachmentIds) {
      const record = store.getAttachment(attachmentId);
      if (record?.storagePath === null || record?.storagePath === undefined) continue;
      try {
        storage.remove(record.storagePath);
        store.updateAttachment(attachmentId, { storagePath: null });
      } catch (error) {
        this.#options.logger?.warn(
          `[dsh-android-gateway] 清理附件暂存失败 ${attachmentId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** TTL 清理：删除过期字节并投影为 expired。 */
  expireDue(accountId: string): number {
    const store = this.#options.accounts.openStore(accountId);
    if (store === undefined) return 0;
    const storage = this.#storage(accountId);
    let expired = 0;
    for (const record of store.listExpiredAttachments(nowIso())) {
      if (record.storagePath !== null) {
        try {
          storage.remove(record.storagePath);
        } catch {
          // 字节删除失败保留记录，下轮重试。
        }
      }
      store.updateAttachment(record.attachmentId, { status: "expired", storagePath: null });
      expired += 1;
    }
    return expired;
  }
}
