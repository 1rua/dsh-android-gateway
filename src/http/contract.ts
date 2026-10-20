import type { IncomingMessage, ServerResponse } from "node:http";

import type { EventRecord, GatewayResult, JsonObject, VerifiedRequest } from "../shared/types.js";

/** 一条原始 header；重复字段保留多条，供契约 §6.1 的单例证明使用。 */
export interface RawHeader {
  readonly name: string;
  readonly value: string;
}

/** HTTP 层交给协议层的最小请求视图。 */
export interface RawGatewayRequest {
  readonly method: string;
  readonly target: string;
  readonly headers: readonly RawHeader[];
  readonly body: Uint8Array;
  readonly bodyText: string;
  readonly json: JsonObject | null;
  /**
   * 附件内容 PUT 的签名预像使用 `Digest` header 声明的摘要（流式上传不缓冲 body）。
   * HTTP 层把 `Digest: sha-256=<base64>` 解码成 64 位小写 hex 后放这里。
   */
  readonly declaredBodyDigestHex?: string;
}

/**
 * 请求验证：把原始请求变成已认证身份。
 * 失败必须抛 `GatewayError`（AUTHENTICATION_REQUIRED / SIGNATURE_INVALID / …）。
 */
export interface RequestVerifier {
  verify(request: RawGatewayRequest): Promise<VerifiedRequest>;
  /** 契约 §5.5：登出路由只校验 Bearer 与五个身份 header，不做时间/nonce/签名。 */
  verifyLogout(request: RawGatewayRequest): Promise<VerifiedRequest>;
}

export interface AttachmentUploadFile {
  /** HTTP 层已把 entity-body 流式写入的临时文件。 */
  readonly filePath: string;
  readonly contentLength: number;
  /** 实际字节的小写十六进制 SHA-256。 */
  readonly sha256Hex: string;
}

/** 事件流服务：游标重放 + 实时订阅。 */
export interface EventSubscription {
  readonly replay: readonly EventRecord[];
  subscribe(listener: (event: EventRecord) => void): () => void;
}

export interface EventStreamService {
  open(accountId: string, cursor: string | null): Promise<EventSubscription>;
}

/**
 * 协议业务入口。HTTP 层只负责传输、鉴权、信封与 SSE 帧写；所有语义在 core。
 * 所有方法抛 `GatewayError` 表示契约失败，返回值表示成功。
 */
export interface GatewayCore {
  negotiate(request: RawGatewayRequest): Promise<GatewayResult>;
  passwordLogin(request: RawGatewayRequest): Promise<GatewayResult>;
  refresh(request: RawGatewayRequest): Promise<GatewayResult>;
  inviteChallenge(request: RawGatewayRequest): Promise<GatewayResult>;
  inviteExchange(request: RawGatewayRequest): Promise<GatewayResult>;
  deviceChallenge(request: RawGatewayRequest): Promise<GatewayResult>;
  deviceLogin(request: RawGatewayRequest): Promise<GatewayResult>;
  logout(request: VerifiedRequest): Promise<GatewayResult>;
  /** 其余已认证 JSON 路由：由 core 按 method + path 分派。 */
  handle(request: VerifiedRequest): Promise<GatewayResult>;
  /** `PUT /attachments/{id}/content`：HTTP 层已流式落到临时文件。 */
  uploadAttachmentContent(request: VerifiedRequest, upload: AttachmentUploadFile): Promise<GatewayResult>;
}

export type GatewayHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface GatewayHttpOptions {
  readonly mountPath?: string;
  readonly maxJsonBodyBytes?: number;
  readonly maxAttachmentBytes?: number;
  readonly heartbeatMs?: number;
  readonly logger?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}
