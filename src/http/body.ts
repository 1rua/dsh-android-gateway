import type { IncomingMessage } from "node:http";

import { GatewayError } from "../shared/errors.js";

/** JSON body 默认上限（契约/任务约定 1 MiB）。 */
export const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;

/** 附件内容默认上限（任务约定 256 MiB）。 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024;

export const bodyTooLarge = (limitBytes: number, receivedBytes?: number): GatewayError =>
  new GatewayError("SCHEMA_INVALID", "Request entity-body exceeds the transport limit", {
    details: receivedBytes === undefined ? { limitBytes } : { limitBytes, receivedBytes },
  });

/**
 * 把 entity-body 读成字节。extract 严格停留在 HTTP transfer framing 解码后的原始字节，
 * 不做字符转换、JSON decode 或解压；签名/摘要都依赖这份字节。
 *
 * 必须配合 `Content-Length` 有界读取：调用方先做长度预检，这里再对实际读数兜底。
 */
export const readEntityBody = async (
  req: IncomingMessage,
  limitBytes: number,
  declaredLength: number | null,
): Promise<Uint8Array> => {
  const chunks: Buffer[] = [];
  let received = 0;

  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      received += buffer.byteLength;
      if (received > limitBytes) throw bodyTooLarge(limitBytes, received);
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    // 客户端中断或 socket 错误：只返回契约信封，不把底层异常抛给 DSH。
    throw new GatewayError("SCHEMA_INVALID", "Failed to read the request entity-body", {
      cause: error,
    });
  }

  // Node 的 llhttp 已按 Content-Length 切帧；这里再核对一次，避免截断 body 被验签掩盖。
  if (declaredLength !== null && received !== declaredLength) {
    throw new GatewayError(
      "SCHEMA_INVALID",
      `Content-Length declared ${declaredLength} bytes but ${received} bytes were received`,
      { details: { declaredLength, receivedBytes: received } },
    );
  }

  return Buffer.concat(chunks);
};
