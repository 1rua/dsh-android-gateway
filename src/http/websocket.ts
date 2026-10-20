import { createHash } from "node:crypto";
import { appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { GatewayError, asGatewayError } from "../shared/errors.js";
import type { EventRecord } from "../shared/types.js";
import type { RawGatewayRequest, RequestVerifier, EventStreamService } from "./contract.js";
import { collectRawHeaders, headerValue, validateContractHeaders } from "./headers.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;
const MAX_FRAME_BYTES = 1_048_576;

export interface WebSocketHandlerOptions {
  readonly mountPath: string;
  /** 诊断日志目录；仅记录协议错误，不含头值与事件正文。 */
  readonly diagnosticsDir?: string;
  readonly verifier: RequestVerifier;
  readonly events: EventStreamService;
  readonly heartbeatMs: number;
  readonly logger?: { warn(message: string): void };
}

const acceptKey = (key: string): string =>
  createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");

const encodeFrame = (opcode: number, payload: Buffer): Buffer => {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
};

const eventFrame = (event: EventRecord): Buffer =>
  encodeFrame(
    OPCODE_TEXT,
    Buffer.from(
      JSON.stringify({
        id: event.eventId,
        event: event.type,
        data: {
          correlationId: event.correlationId,
          occurredAt: event.occurredAt,
          payload: event.payload,
        },
      }),
      "utf8",
    ),
  );

interface ParsedFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
  readonly consumed: number;
}

/** 解析一个客户端帧（客户端帧必须带 mask）；数据不足返回 undefined。 */
const parseFrame = (buffer: Buffer): ParsedFrame | undefined => {
  if (buffer.length < 2) return undefined;
  const first = buffer[0]!;
  const second = buffer[1]!;
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  if (!masked) throw new Error("WEBSOCKET_PROTOCOL_ERROR:client frames must be masked");
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(MAX_FRAME_BYTES)) throw new Error("WEBSOCKET_FRAME_TOO_LARGE");
    length = Number(big);
    offset += 8;
  }
  if (length > MAX_FRAME_BYTES) throw new Error("WEBSOCKET_FRAME_TOO_LARGE");
  if (buffer.length < offset + 4 + length) return undefined;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = payload[index]! ^ mask[index % 4]!;
  }
  return { fin, opcode, payload, consumed: offset + length };
};

const writeHttpFailure = (socket: Duplex, status: number, message: string): void => {
  const body = Buffer.from(message, "utf8");
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 410 ? "Gone" : "Bad Request"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n\r\n`,
  );
  socket.write(body);
  socket.end();
};

/**
 * `/events/ws` 的 RFC 6455 服务端。
 *
 * 握手是一个带九 header 签名的 GET；升级成功后事件以 `{id,event,data}` 文本帧下发，
 * 心跳使用 WebSocket Ping 帧。游标过期在升级前以 HTTP 410 返回，App 据此重建。
 */
export const createGatewayWebSocketHandler = (options: WebSocketHandlerOptions) => {
  const path = `${options.mountPath}/events/ws`;
  const diagnostic = (message: string): void => {
    if (options.diagnosticsDir === undefined) return;
    try {
      const file = join(options.diagnosticsDir, "diagnostics.log");
      appendFileSync(file, `${new Date().toISOString()}\twebsocket\t${message}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch {
      // 诊断失败不影响协议。
    }
  };
  return async (req: IncomingMessage, socket: Duplex): Promise<void> => {
    const origin = `http://${req.headers.host ?? "localhost"}`;
    const target = req.url ?? path;
    diagnostic(`invoked target=${target.slice(0, 120)}`);
    try {
      const headers = collectRawHeaders(req.rawHeaders);
      validateContractHeaders(headers);
      const rawRequest: RawGatewayRequest = {
        method: "GET",
        target,
        headers,
        body: new Uint8Array(0),
        bodyText: "",
        json: null,
      };
      const verified = await options.verifier.verify(rawRequest);
      const cursorValues = verified.query.getAll("cursor");
      if (cursorValues.length > 1) {
        throw new GatewayError("SCHEMA_INVALID", "At most one cursor is allowed");
      }
      const cursor = cursorValues[0] === undefined || cursorValues[0] === "" ? null : cursorValues[0];
      const subscription = await options.events.open(verified.accountId, cursor);
      const key = headerValue(headers, "sec-websocket-key");
      if (key === null || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
        throw new GatewayError("SCHEMA_INVALID", "Invalid Sec-WebSocket-Key");
      }
      diagnostic(`upgrade accepted account=${verified.accountId} cursor=${cursor ?? "-"}`);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      );

      let closed = false;
      let pending = Promise.resolve();
      const send = (frame: Buffer): void => {
        if (closed) return;
        pending = pending.then(
          () =>
            new Promise<void>((resolve) => {
              if (closed) {
                resolve();
                return;
              }
              let canContinue: boolean;
              try {
                canContinue = socket.write(frame);
              } catch (error) {
                diagnostic(`write failed: ${error instanceof Error ? error.message : String(error)}`);
                throw error;
              }
              if (canContinue) resolve();
              else socket.once("drain", () => resolve());
            }),
        );
      };

      for (const event of subscription.replay) send(eventFrame(event));
      const unsubscribe = subscription.subscribe((event) => send(eventFrame(event)));
      const heartbeat = setInterval(() => {
        diagnostic("heartbeat ping");
        send(encodeFrame(OPCODE_PING, Buffer.alloc(0)));
      }, options.heartbeatMs);
      heartbeat.unref?.();

      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let fragmentedText = Buffer.alloc(0);
      let fragmentOpcode = -1;
      const cleanup = (): void => {
        if (closed) return;
        diagnostic("cleanup");
        closed = true;
        clearInterval(heartbeat);
        try {
          unsubscribe();
        } catch {
          // 订阅已被事件中心清理。
        }
        socket.removeAllListeners();
        if (!socket.destroyed) socket.end();
      };

      socket.on("data", (chunk: Buffer) => {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        try {
          while (true) {
            const frame = parseFrame(buffer);
            if (frame === undefined) break;
            buffer = buffer.subarray(frame.consumed);
            if (frame.opcode === OPCODE_PING) {
              send(encodeFrame(OPCODE_PONG, frame.payload));
              continue;
            }
            if (frame.opcode === OPCODE_PONG) continue;
            if (frame.opcode === OPCODE_CLOSE) {
              send(encodeFrame(OPCODE_CLOSE, frame.payload.subarray(0, 2)));
              cleanup();
              return;
            }
            if (frame.opcode === OPCODE_TEXT || frame.opcode === OPCODE_BINARY) {
              if (frame.opcode === OPCODE_BINARY) continue;
              // 客户端文本帧不承载业务（事件流是服务端推送）；忽略但保持连接。
              fragmentedText = Buffer.alloc(0);
              fragmentOpcode = -1;
              continue;
            }
            if (frame.opcode === OPCODE_CONTINUATION) {
              fragmentedText = Buffer.concat([fragmentedText, frame.payload]);
              if (frame.fin) {
                fragmentedText = Buffer.alloc(0);
                fragmentOpcode = -1;
              }
            }
          }
        } catch (error) {
          options.logger?.warn(
            `[dsh-android-gateway] websocket protocol error from ${origin}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          cleanup();
        }
      });
      socket.on("error", (error: Error) => {
        diagnostic(`socket error: ${error.message}`);
        options.logger?.warn(`[dsh-android-gateway] websocket error: ${error.message}`);
        cleanup();
      });
      socket.on("close", () => {
        diagnostic("socket close");
        cleanup();
      });
      socket.on("end", () => {
        diagnostic("socket end");
        cleanup();
      });
    } catch (error) {
      const gatewayError = asGatewayError(error);
      if (options.diagnosticsDir !== undefined) {
        try {
          const path = join(options.diagnosticsDir, "diagnostics.log");
          appendFileSync(path, `${new Date().toISOString()}\twebsocket\t${gatewayError.code}\t${gatewayError.message}\n`, { mode: 0o600 });
          chmodSync(path, 0o600);
        } catch {
          // 诊断失败不影响 HTTP 拒绝。
        }
      }
      const status =
        gatewayError.code === "CURSOR_EXPIRED"
          ? 410
          : gatewayError.code === "AUTHENTICATION_REQUIRED" ||
              gatewayError.code === "AUTHENTICATION_FAILED" ||
              gatewayError.code === "SIGNATURE_INVALID" ||
              gatewayError.code === "SESSION_EXPIRED" ||
              gatewayError.code === "SESSION_REVOKED"
            ? 401
            : 400;
      writeHttpFailure(socket, status, gatewayError.code);
    }
  };
};
