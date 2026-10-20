import type {
  AccessSessionRecord,
  AttachmentRecord,
  AttachmentStatus,
  ConversationRecord,
  DeviceRecord,
  EventRecord,
  GenerationRecord,
  IdempotencyRecord,
  JsonObject,
  MessagePart,
  MessageRecord,
  MessageStatus,
  OrganizationRecord,
  RefreshCredentialRecord,
} from "../shared/types.js";

export interface NonceRecord {
  readonly nonce: string;
  readonly expiresAt: string;
}

export interface InsertDeviceInput {
  readonly deviceId: string;
  readonly installationId: string;
  readonly publicKey: string;
  readonly displayName: string;
  readonly pairingId: string;
  readonly pairingGeneration: number;
  readonly pairedAt: string;
}

export interface InsertRefreshCredentialInput {
  readonly credentialHash: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly createdAt: string;
}

export interface InsertAccessSessionInput {
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly deviceId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AppendEventInput {
  readonly eventId: string;
  readonly type: string;
  readonly payload: JsonObject;
  readonly occurredAt: string;
  readonly correlationId: string;
}

export interface InsertConversationInput {
  readonly conversationId: string;
  readonly clientConversationId: string;
  readonly dshSessionId: string | null;
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InsertMessageInput {
  readonly messageId: string;
  readonly conversationId: string;
  readonly clientMessageId: string | null;
  readonly sender: string;
  readonly text: string;
  readonly parts: readonly MessagePart[];
  readonly status: MessageStatus;
  readonly revision: number;
  readonly errorCode: string | null;
  readonly generationId: string | null;
  readonly dshSeq: number | null;
  readonly createdAt: string;
}

export interface InsertGenerationInput {
  readonly generationId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly state: GenerationRecord["state"];
  readonly createdAt: string;
}

export interface InsertAttachmentInput {
  readonly attachmentId: string;
  readonly clientAttachmentId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly status: AttachmentStatus;
  readonly storagePath: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type MessagePatch = Partial<{
  status: MessageStatus;
  revision: number;
  errorCode: string | null;
  text: string;
  parts: readonly MessagePart[];
  dshSeq: number | null;
  updatedAt: string;
  generationId: string | null;
}>;

export type ConversationPatch = Partial<{
  dshSessionId: string | null;
  title: string | null;
  archived: boolean;
  deleted: boolean;
  updatedAt: string;
  lastMessageAt: string | null;
}>;

export type AttachmentPatch = Partial<{
  status: AttachmentStatus;
  storagePath: string | null;
  dshAttachmentId: string | null;
  sizeBytes: number;
  sha256: string;
}>;

export type GenerationPatch = Partial<{
  state: GenerationRecord["state"];
  endedAt: string | null;
}>;

/**
 * 单个 Gateway 账号的持久化接口。所有实现必须：
 * - 用事务包裹多步写入；
 * - 不抛出的 SQL 细节进入业务层；
 * - 对象返回值与内部行解耦（不可变快照）。
 */
export interface AccountStore {
  close(): void;

  // 设备与配对
  insertDevice(input: InsertDeviceInput): DeviceRecord;
  getDevice(deviceId: string): DeviceRecord | undefined;
  listDevices(): readonly DeviceRecord[];
  revokeDevice(deviceId: string, revokedAt: string): void;
  bumpPairingGeneration(deviceId: string, next: number): DeviceRecord | undefined;

  // refresh 凭据
  insertRefreshCredential(input: InsertRefreshCredentialInput): RefreshCredentialRecord;
  findRefreshCredential(hash: string): RefreshCredentialRecord | undefined;
  revokeRefreshCredential(hash: string, revokedAt: string): void;
  revokeRefreshCredentialsForDevice(deviceId: string, revokedAt: string): number;

  // access session
  insertAccessSession(input: InsertAccessSessionInput): AccessSessionRecord;
  findAccessSessionByTokenHash(tokenHash: string): AccessSessionRecord | undefined;
  findAccessSession(sessionId: string): AccessSessionRecord | undefined;
  revokeAccessSession(sessionId: string, revokedAt: string): void;
  revokeAccessSessionsForDevice(deviceId: string, revokedAt: string): number;
  pruneExpiredAccessSessions(nowIso: string): number;

  // nonce 防重放
  hasNonce(nonce: string): boolean;
  recordNonce(nonce: string, expiresAt: string): void;
  pruneNonces(nowIso: string): number;

  // 幂等账本
  findIdempotency(scope: string, requestId: string): IdempotencyRecord | undefined;
  saveIdempotency(record: IdempotencyRecord): void;

  // 事件流
  appendEvent(input: AppendEventInput): EventRecord;
  listEventsAfter(seq: number, limit: number): readonly EventRecord[];
  findEventByEventId(eventId: string): EventRecord | undefined;
  latestEventSeq(): number;
  oldestEventSeq(): number | null;
  pruneEvents(olderThanIso: string): number;

  // 会话
  insertConversation(input: InsertConversationInput): ConversationRecord;
  getConversation(conversationId: string): ConversationRecord | undefined;
  findConversationByClientId(clientConversationId: string): ConversationRecord | undefined;
  listConversations(): readonly ConversationRecord[];
  updateConversation(conversationId: string, patch: ConversationPatch): ConversationRecord | undefined;
  nextSnapshotRevision(): number;

  // 消息
  insertMessage(input: InsertMessageInput): MessageRecord;
  getMessage(messageId: string): MessageRecord | undefined;
  findMessageByClientId(conversationId: string, clientMessageId: string): MessageRecord | undefined;
  listMessages(conversationId: string): readonly MessageRecord[];
  updateMessage(messageId: string, patch: MessagePatch): MessageRecord | undefined;
  findMessageByDshSeq(conversationId: string, dshSeq: number): MessageRecord | undefined;

  // 生成
  insertGeneration(input: InsertGenerationInput): GenerationRecord;
  getGeneration(generationId: string): GenerationRecord | undefined;
  findGenerationByMessage(messageId: string): GenerationRecord | undefined;
  listActiveGenerations(conversationId: string): readonly GenerationRecord[];
  updateGeneration(generationId: string, patch: GenerationPatch): GenerationRecord | undefined;

  // 附件
  insertAttachment(input: InsertAttachmentInput): AttachmentRecord;
  getAttachment(attachmentId: string): AttachmentRecord | undefined;
  findAttachmentByClientId(clientAttachmentId: string): AttachmentRecord | undefined;
  updateAttachment(attachmentId: string, patch: AttachmentPatch): AttachmentRecord | undefined;
  listExpiredAttachments(nowIso: string): readonly AttachmentRecord[];

  // 会话组织
  getOrganization(): OrganizationRecord;
  replaceOrganization(expectedRevision: number, next: Omit<OrganizationRecord, "revision">): OrganizationRecord;
}

/** 打开（或创建）一个账号的数据库。目录由调用方保证已创建并收紧权限。 */
export type OpenAccountStore = (databasePath: string) => AccountStore;
