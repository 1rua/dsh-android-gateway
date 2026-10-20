import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { EventSubscription, RequestVerifier } from "../../src/http/contract.js";
import { createGatewayWebSocketHandler } from "../../src/http/websocket.js";
import type { EventRecord, VerifiedRequest } from "../../src/shared/types.js";

const MOUNT = "/open-android-intelligence/v2";
const AUTH_HEADERS = [
  ["Authorization", "Bearer token"],
  ["X-Open-Android-Intelligence-Protocol", "2.1"],
  ["X-Open-Android-Intelligence-Account", "acct_1"],
  ["X-Open-Android-Intelligence-Device", "dev_1"],
  ["X-Open-Android-Intelligence-Session", "sess_1"],
  ["X-Open-Android-Intelligence-Request-Id", "req_1"],
  ["X-Open-Android-Intelligence-Timestamp", "2026-10-20T12:00:00.000Z"],
  ["X-Open-Android-Intelligence-Nonce", "AAAAAAAAAAAAAAAAAAAAAA"],
  ["X-Open-Android-Intelligence-Signature", "A".repeat(86)],
] as const;

const event = (): EventRecord => ({
  seq: 1,
  eventId: "evt_1",
  type: "conversation.message.status",
  payload: { conversationId: "conv_1", status: "queued" },
  occurredAt: "2026-10-20T12:00:00.000Z",
  correlationId: "req_1",
});

const fakeVerifier = (): RequestVerifier => ({
  async verify(): Promise<VerifiedRequest> {
    return {
      method: "GET",
      target: `${MOUNT}/events/ws`,
      path: `${MOUNT}/events/ws`,
      query: new URLSearchParams(),
      requestId: "req_1",
      correlationId: "req_1",
      accountId: "acct_1",
      deviceId: "dev_1",
      sessionId: "sess_1",
      device: {
        deviceId: "dev_1",
        installationId: "install_1",
        publicKey: "k",
        displayName: "phone",
        pairingId: "pair_1",
        pairingGeneration: 1,
        pairedAt: "2026-10-20T12:00:00.000Z",
        revokedAt: null,
      },
      body: new Uint8Array(0),
      bodyText: "",
      json: null,
      idempotencyKey: null,
      contentType: null,
      contentLength: null,
      headers: [],
    };
  },
  async verifyLogout(): Promise<VerifiedRequest> {
    throw new Error("unused");
  },
});

const maskedFrame = (opcode: number, payload: Buffer): Buffer => {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = masked[index]! ^ mask[index % 4]!;
  }
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
};

interface RawFrame {
  readonly opcode: number;
  readonly payload: Buffer;
}

describe("WebSocket 事件传输", () => {
  const sockets: Socket[] = [];
  afterEach(() => {
    for (const socket of sockets) socket.destroy();
    sockets.length = 0;
  });

  it("完成握手、先重放再实时投递，并响应 close", async () => {
    const listeners = new Set<(event: EventRecord) => void>();
    const subscription: EventSubscription = {
      replay: [event()],
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const handler = createGatewayWebSocketHandler({
      mountPath: MOUNT,
      verifier: fakeVerifier(),
      events: {
        async open() {
          return subscription;
        },
      },
      heartbeatMs: 60_000,
    });
    const server = createServer();
    server.on("upgrade", (req, socket) => {
      void handler(req, socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("no address");
    const socket = connect(address.port, "127.0.0.1");
    sockets.push(socket);
    await new Promise<void>((resolve) => socket.once("connect", resolve));

    const key = randomBytes(16).toString("base64");
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `GET ${MOUNT}/events/ws HTTP/1.1\r\n` +
        "Host: 127.0.0.1\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n" +
        AUTH_HEADERS.map(([name, value]) => `${name}: ${value}\r\n`).join("") +
        "\r\n",
    );

    let raw = Buffer.alloc(0);
    let handshakeText = "";
    let handshakeDone = false;
    let resolveHandshake: () => void = () => undefined;
    const handshakePromise = new Promise<void>((resolve) => {
      resolveHandshake = resolve;
    });
    const frameQueue: RawFrame[] = [];
    const frameWaiters: Array<(frame: RawFrame) => void> = [];
    const pushFrame = (frame: RawFrame): void => {
      const waiter = frameWaiters.shift();
      if (waiter !== undefined) waiter(frame);
      else frameQueue.push(frame);
    };
    const nextFrame = (): Promise<RawFrame> => {
      const queued = frameQueue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => frameWaiters.push(resolve));
    };
    socket.on("data", (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
      if (!handshakeDone) {
        const boundary = raw.indexOf("\r\n\r\n");
        if (boundary === -1) return;
        handshakeText = raw.subarray(0, boundary + 4).toString("latin1");
        raw = raw.subarray(boundary + 4);
        handshakeDone = true;
        resolveHandshake();
      }
      while (true) {
        if (raw.length < 2) return;
        const opcode = raw[0]! & 0x0f;
        let length = raw[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (raw.length < 4) return;
          length = raw.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (raw.length < 10) return;
          length = Number(raw.readBigUInt64BE(2));
          offset = 10;
        }
        if (raw.length < offset + length) return;
        pushFrame({ opcode, payload: raw.subarray(offset, offset + length) });
        raw = raw.subarray(offset + length);
      }
    });

    await handshakePromise;
    expect(handshakeText.startsWith("HTTP/1.1 101")).toBe(true);
    expect(handshakeText.toLowerCase()).toContain(`sec-websocket-accept: ${accept}`.toLowerCase());

    const replayFrame = await nextFrame();
    expect(replayFrame.opcode).toBe(0x1);
    const replayed = JSON.parse(replayFrame.payload.toString("utf8")) as {
      id: string;
      event: string;
      data: { payload: { status: string } };
    };
    expect(replayed).toMatchObject({
      id: "evt_1",
      event: "conversation.message.status",
      data: { payload: { status: "queued" } },
    });

    const liveEvent = { ...event(), eventId: "evt_2", seq: 2 };
    for (const listener of listeners) listener(liveEvent);
    const liveFrame = await nextFrame();
    expect(JSON.parse(liveFrame.payload.toString("utf8"))).toMatchObject({ id: "evt_2" });

    socket.write(maskedFrame(0x8, Buffer.from([0x03, 0xe8])));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listeners.size).toBe(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
