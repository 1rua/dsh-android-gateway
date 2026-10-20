/** 共享的 wire 与持久化类型。除特别说明外，所有时间均为 RFC 3339 UTC 毫秒字符串或 epoch 毫秒。 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** 账号注册表条目（`accounts.json`），只保存 scrypt 摘要，不保存明文密码。 */
export interface AccountRegistration {
  readonly accountId: string;
  readonly username: string;
  readonly passwordSalt: string;
  readonly passwordHash: string;
  readonly createdAt: string;
}

export interface AccountRegistryFile {
  readonly version: 1;
  readonly deploymentId: string;
  readonly accounts: AccountRegistration[];
}

/** 一个已配对设备（账号内隔离）。 */
export interface DeviceRecord {
  readonly deviceId: string;
  readonly installationId: string;
  readonly publicKey: string;
  readonly displayName: string;
  readonly pairingId: string;
  readonly pairingGeneration: number;
  readonly pairedAt: string;
  readonly revokedAt: string | null;
}

export interface RefreshCredentialRecord {
  readonly credentialHash: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface AccessSessionRecord {
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly deviceId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

/** 账号事件流中的一条事件。 */
export interface EventRecord {
  readonly seq: number;
  readonly eventId: string;
  readonly type: string;
  readonly payload: JsonObject;
  readonly occurredAt: string;
  readonly correlationId: string;
}

export type ConversationDeleted = {
  readonly deleted: true;
};

export interface ConversationRecord {
  readonly conversationId: string;
  readonly clientConversationId: string;
  readonly dshSessionId: string | null;
  readonly title: string | null;
  readonly archived: boolean;
  readonly deleted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastMessageAt: string | null;
  readonly snapshotRevision: number;
}

export type MessagePart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "attachment";
      readonly attachmentId: string;
      readonly filename?: string;
      readonly mediaType?: string;
      readonly sizeBytes?: number;
      readonly sha256?: string;
    };

export type MessageStatus = "queued" | "delivered" | "completed" | "failed";

export interface MessageRecord {
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
  /** 对应 DSH Session 日志中的事件序号；发送前为 null。 */
  readonly dshSeq: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GenerationRecord {
  readonly generationId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly state: "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export type AttachmentStatus = "staged" | "uploaded" | "failed" | "expired";

export interface AttachmentRecord {
  readonly attachmentId: string;
  readonly clientAttachmentId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly status: AttachmentStatus;
  readonly storagePath: string | null;
  readonly dshAttachmentId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ConversationFolder {
  readonly folderId: string;
  readonly name: string;
}

export interface OrganizationRecord {
  readonly revision: number;
  readonly sortMode: "updated-desc" | "custom";
  readonly customOrder: readonly string[];
  readonly folders: readonly ConversationFolder[];
  readonly assignments: Record<string, string>;
}

/** 幂等账本条目。 */
export interface IdempotencyRecord {
  readonly scope: string;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly responseJson: string;
  readonly createdAt: string;
}

/** 已认证请求：身份只能来自签名验证，业务层不得再读取 header/body 中的身份字段。 */
export interface VerifiedRequest {
  readonly method: string;
  readonly target: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly requestId: string;
  readonly correlationId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly device: DeviceRecord;
  readonly body: Uint8Array;
  readonly bodyText: string;
  readonly json: JsonObject | null;
  readonly idempotencyKey: string | null;
  /** 传输元数据；业务层不得从中重新读取身份。 */
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
}

export interface GatewayResult {
  readonly status: number;
  readonly data: JsonObject;
  /** 覆盖 envelope 的 correlationId（预认证响应回显客户端 negotiationId 时需要）。 */
  readonly correlationId?: string;
  /** 原始响应字节（附件流等非 JSON 响应）。 */
  readonly raw?: {
    readonly contentType: string;
    readonly body: Uint8Array;
    readonly headers?: Record<string, string>;
  };
}

export interface NegotiationRequest {
  readonly negotiationId: string;
  readonly protocol: { readonly major: number; readonly minor: number };
  readonly client: {
    readonly installationId: string;
    readonly appVersion: string;
    readonly platform: "android";
    readonly platformApi: number;
  };
  readonly features: {
    readonly auth: readonly string[];
    readonly messages: readonly string[];
    readonly attachments: readonly string[];
    readonly events: readonly string[];
    readonly deviceRequests: readonly string[];
    readonly conversationUi?: readonly string[];
  };
  readonly schemaHashes: { readonly core: string };
}

export interface NegotiationResult {
  readonly negotiation: NegotiationRequest;
  readonly agreedConversationUi: readonly string[];
  readonly agreedAuth: readonly string[];
}

export interface LoginInstallation {
  readonly installationId: string;
  readonly displayName: string;
  readonly devicePublicKey: string;
}

export interface SessionBundle {
  readonly accountId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshCredential: string;
  readonly expiresAt: string;
  readonly pairingId: string;
  readonly pairingGeneration: number;
  readonly grantRevision: number;
  readonly pairingSummary: string;
}

/** 多账号注册表：登录解析账号、生成 deploymentId。 */
export interface AccountRegistryApi {
  deploymentId(): string;
  list(): readonly AccountRegistration[];
  findById(accountId: string): AccountRegistration | undefined;
  findByUsername(username: string): AccountRegistration | undefined;
  add(registration: AccountRegistration): Promise<void>;
  remove(accountId: string): Promise<void>;
}

export type TimerHandle = { readonly dispose: () => void };
