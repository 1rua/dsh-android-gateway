import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createConnection } from "node:net";

import type { EventRecord, GatewayResult, VerifiedRequest } from "../../src/shared/types.js";
import type {
  AttachmentUploadFile,
  EventStreamService,
  EventSubscription,
  GatewayCore,
  GatewayHttpHandler,
  GatewayHttpOptions,
  RawGatewayRequest,
  RawHeader,
  RequestVerifier,
} from "../../src/http/contract.js";
import { createGatewayHttpHandler } from "../../src/http/index.js";

export const FAKE_ACCOUNT_ID = "acct_1";
export const FAKE_DEVICE_ID = "dev_1";
export const FAKE_SESSION_ID = "sess_1";
export const FAKE_REQUEST_ID = "req_test_1";

const AUTH_HEADER_NAMES = [
  "Authorization",
  "X-Open-Android-Intelligence-Protocol",
  "X-Open-Android-Intelligence-Account",
  "X-Open-Android-Intelligence-Device",
  "X-Open-Android-Intelligence-Session",
  "X-Open-Android-Intelligence-Request-Id",
  "X-Open-Android-Intelligence-Timestamp",
  "X-Open-Android-Intelligence-Nonce",
  "X-Open-Android-Intelligence-Signature",
] as const;

/** 构造九个认证 header；omit 用于测试缺 header，overrides 用于重复/折叠值。 */
export const buildAuthHeaders = (options: {
  readonly omit?: readonly string[];
  readonly overrides?: Readonly<Record<string, string>>;
  /** 默认不加幂等键；POST/PUT/PATCH/DELETE 请用 buildMutationHeaders。 */
  readonly idempotencyKey?: string | null;
} = {}): Record<string, string> => {
  const values: Record<string, string> = {
    Authorization: "Bearer test-token",
    "X-Open-Android-Intelligence-Protocol": "2.1",
    "X-Open-Android-Intelligence-Account": FAKE_ACCOUNT_ID,
    "X-Open-Android-Intelligence-Device": FAKE_DEVICE_ID,
    "X-Open-Android-Intelligence-Session": FAKE_SESSION_ID,
    "X-Open-Android-Intelligence-Request-Id": FAKE_REQUEST_ID,
    "X-Open-Android-Intelligence-Timestamp": "2026-10-20T00:00:00.000Z",
    "X-Open-Android-Intelligence-Nonce": "AAAAAAAAAAAAAAAAAAAAAA",
    "X-Open-Android-Intelligence-Signature": "A".repeat(86),
  };
  const omitted = new Set((options.omit ?? []).map((name) => name.toLowerCase()));
  const headers: Record<string, string> = {};
  for (const name of AUTH_HEADER_NAMES) {
    if (omitted.has(name.toLowerCase())) continue;
    headers[name] = values[name] as string;
  }
  if (options.idempotencyKey !== undefined && options.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  for (const [name, value] of Object.entries(options.overrides ?? {})) {
    const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    if (existing !== undefined) delete headers[existing];
    headers[name] = value;
  }
  return headers;
};

/** 认证的 POST/PUT/PATCH/DELETE 必须携带 Idempotency-Key == Request-Id。 */
export const buildMutationHeaders = (options: {
  readonly omit?: readonly string[];
  readonly overrides?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string | null;
} = {}): Record<string, string> =>
  buildAuthHeaders({
    ...options,
    idempotencyKey: options.idempotencyKey === undefined ? FAKE_REQUEST_ID : options.idempotencyKey,
  });

/** 只保留登出路由要求的六个 header（契约 §5.5 的签名豁免路径）。 */
export const buildLogoutHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: "Bearer test-token",
    "X-Open-Android-Intelligence-Protocol": "2.1",
    "X-Open-Android-Intelligence-Account": FAKE_ACCOUNT_ID,
    "X-Open-Android-Intelligence-Device": FAKE_DEVICE_ID,
    "X-Open-Android-Intelligence-Session": FAKE_SESSION_ID,
  };
  return headers;
};

const headerMap = (headers: readonly RawHeader[]): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const header of headers) {
    const name = header.name.toLowerCase();
    const list = map.get(name) ?? [];
    list.push(header.value);
    map.set(name, list);
  }
  return map;
};

const firstHeader = (headers: readonly RawHeader[], name: string): string | null => {
  const list = headerMap(headers).get(name.toLowerCase());
  return list !== undefined && list.length > 0 ? (list[0] as string) : null;
};

const splitTarget = (target: string): { path: string; query: URLSearchParams } => {
  const queryIndex = target.indexOf("?");
  if (queryIndex === -1) return { path: target, query: new URLSearchParams() };
  return { path: target.slice(0, queryIndex), query: new URLSearchParams(target.slice(queryIndex + 1)) };
};

const fakeDevice = {
  deviceId: FAKE_DEVICE_ID,
  installationId: "install_1",
  publicKey: "A".repeat(43),
  displayName: "Pixel",
  pairingId: "pair_1",
  pairingGeneration: 1,
  pairedAt: "2026-10-20T00:00:00.000Z",
  revokedAt: null,
} as const;

const verifyToVerified = (request: RawGatewayRequest, requestIdFallback: string): VerifiedRequest => {
  const { path, query } = splitTarget(request.target);
  const requestId = firstHeader(request.headers, "x-open-android-intelligence-request-id") ?? requestIdFallback;
  const contentLengthHeader = firstHeader(request.headers, "content-length");
  return {
    method: request.method,
    target: request.target,
    path,
    query,
    requestId,
    correlationId: requestId,
    accountId: firstHeader(request.headers, "x-open-android-intelligence-account") ?? FAKE_ACCOUNT_ID,
    deviceId: firstHeader(request.headers, "x-open-android-intelligence-device") ?? FAKE_DEVICE_ID,
    sessionId: firstHeader(request.headers, "x-open-android-intelligence-session") ?? FAKE_SESSION_ID,
    device: fakeDevice,
    body: request.body,
    bodyText: request.bodyText,
    json: request.json,
    idempotencyKey: firstHeader(request.headers, "idempotency-key"),
    contentType: firstHeader(request.headers, "content-type"),
    contentLength: contentLengthHeader === null ? null : Number(contentLengthHeader),
    headers: request.headers,
  };
};

/** 只做最薄的身份投影；认证失败由 HTTP 层自己的单例校验与注入错误覆盖。 */
export class FakeVerifier implements RequestVerifier {
  readonly verifyCalls: RawGatewayRequest[] = [];
  readonly logoutCalls: RawGatewayRequest[] = [];
  verifyError: unknown = undefined;
  logoutError: unknown = undefined;

  async verify(request: RawGatewayRequest): Promise<VerifiedRequest> {
    this.verifyCalls.push(request);
    if (this.verifyError !== undefined) throw this.verifyError;
    return verifyToVerified(request, "req_fake");
  }

  async verifyLogout(request: RawGatewayRequest): Promise<VerifiedRequest> {
    this.logoutCalls.push(request);
    if (this.logoutError !== undefined) throw this.logoutError;
    return verifyToVerified(request, "req_logout");
  }
}

export class FakeEventStream implements EventStreamService {
  replay: readonly EventRecord[] = [];
  openError: unknown = undefined;
  readonly openCalls: Array<{ accountId: string; cursor: string | null }> = [];
  private readonly listeners = new Set<(event: EventRecord) => void>();
  unsubscribeCount = 0;

  async open(accountId: string, cursor: string | null): Promise<EventSubscription> {
    this.openCalls.push({ accountId, cursor });
    if (this.openError !== undefined) throw this.openError;
    const replay = this.replay;
    return {
      replay,
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
          this.unsubscribeCount += 1;
        };
      },
    };
  }

  emit(event: EventRecord): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

export type CoreOperation =
  | "negotiate"
  | "passwordLogin"
  | "refresh"
  | "inviteChallenge"
  | "inviteExchange"
  | "deviceChallenge"
  | "deviceLogin"
  | "logout"
  | "handle"
  | "uploadAttachmentContent";

export interface CoreCall {
  readonly operation: CoreOperation;
  readonly request: RawGatewayRequest | VerifiedRequest;
  readonly upload?: AttachmentUploadFile;
}

export class FakeCore implements GatewayCore {
  readonly calls: CoreCall[] = [];
  readonly errors = new Map<CoreOperation, unknown>();
  result: GatewayResult = { status: 200, data: { ok: true } };
  uploadProbe: ((upload: AttachmentUploadFile) => void) | undefined;

  private async run(
    operation: CoreOperation,
    request: RawGatewayRequest | VerifiedRequest,
  ): Promise<GatewayResult> {
    this.calls.push({ operation, request });
    const error = this.errors.get(operation);
    if (error !== undefined) throw error;
    return this.result;
  }

  async negotiate(request: RawGatewayRequest): Promise<GatewayResult> {
    return this.run("negotiate", request);
  }

  async passwordLogin(request: RawGatewayRequest): Promise<GatewayResult> {
    return this.run("passwordLogin", request);
  }

  async refresh(request: RawGatewayRequest): Promise<GatewayResult> {
    return this.run("refresh", request);
  }

  async inviteChallenge(request: RawGatewayRequest): Promise<GatewayResult> {
    return this.run("inviteChallenge", request);
  }

  async inviteExchange(request: RawGatewayRequest): Promise<GatewayResult> {
    return this.run("inviteExchange", request);
  }

  async deviceChallenge(request: RawGatewayRequest): Promise<GatewayResult> {
    return this.run("deviceChallenge", request);
  }

  async deviceLogin(request: RawGatewayRequest): Promise<GatewayResult> {
    return this.run("deviceLogin", request);
  }

  async logout(request: VerifiedRequest): Promise<GatewayResult> {
    return this.run("logout", request);
  }

  async handle(request: VerifiedRequest): Promise<GatewayResult> {
    return this.run("handle", request);
  }

  async uploadAttachmentContent(
    request: VerifiedRequest,
    upload: AttachmentUploadFile,
  ): Promise<GatewayResult> {
    this.calls.push({ operation: "uploadAttachmentContent", request, upload });
    this.uploadProbe?.(upload);
    const error = this.errors.get("uploadAttachmentContent");
    if (error !== undefined) throw error;
    return this.result;
  }
}

export interface TestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export const startServer = async (handler: GatewayHttpHandler): Promise<TestServer> => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      if (!res.writableEnded) res.end("handler failure");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
};

export interface GatewayTestBed {
  readonly core: FakeCore;
  readonly verifier: FakeVerifier;
  readonly events: FakeEventStream;
  readonly server: TestServer;
  readonly handler: GatewayHttpHandler;
  url(path: string): string;
}

export const createTestBed = async (options?: GatewayHttpOptions): Promise<GatewayTestBed> => {
  const core = new FakeCore();
  const verifier = new FakeVerifier();
  const events = new FakeEventStream();
  const handler = createGatewayHttpHandler(core, verifier, events, options);
  const server = await startServer(handler);
  return {
    core,
    verifier,
    events,
    server,
    handler,
    url: (path) => `${server.baseUrl}${path}`,
  };
};

/** 用 fetch 发一个带认证头的请求。 */
export const gatewayFetch = async (
  bed: GatewayTestBed,
  path: string,
  init: Omit<RequestInit, "headers"> & { readonly headers?: Record<string, string> } = {},
): Promise<Response> => {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  return fetch(bed.url(path), { ...init, headers });
};

export interface RawHttpResponse {
  readonly status: number;
  readonly headers: Map<string, readonly string[]>;
  readonly body: string;
}

/** 直接写 socket，用于构造 fetch 无法表达的重复 header / 畸形请求。 */
export const rawHttpRequest = async (
  bed: GatewayTestBed,
  options: {
    readonly method: string;
    readonly path: string;
    readonly headers?: readonly (readonly [string, string])[];
    readonly body?: string;
  },
): Promise<RawHttpResponse> => {
  const url = new URL(bed.server.baseUrl);
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  socket.setNoDelay(true);
  const chunks: Buffer[] = [];
  const collected = new Promise<Buffer>((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.on("error", reject);
    socket.setTimeout(5_000, () => socket.destroy(new Error("raw HTTP request timed out")));
  });
  const lines = [
    `${options.method} ${options.path} HTTP/1.1`,
    `Host: ${url.host}`,
    "Connection: close",
    ...(options.headers ?? []).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.write(`${lines.join("\r\n")}\r\n\r\n${options.body ?? ""}`);
  const raw = await collected;
  socket.destroy();

  const separator = raw.indexOf("\r\n\r\n");
  const head = raw.subarray(0, separator === -1 ? raw.length : separator).toString("latin1");
  const body = raw.subarray(separator === -1 ? raw.length : separator + 4).toString("utf8");
  const headLines = head.split("\r\n");
  const statusLine = headLines[0] ?? "";
  const status = Number(statusLine.split(" ")[1] ?? 0);
  const headers = new Map<string, string[]>();
  for (const line of headLines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    const list = headers.get(name) ?? [];
    list.push(value);
    headers.set(name, list);
  }
  return { status, headers, body };
};

export const waitUntil = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met before the timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

interface StreamReadResult {
  readonly done: boolean;
  readonly value?: Uint8Array;
}

const readWithTimeout = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<StreamReadResult> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`SSE read timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** 增量读取 SSE 响应，直到 predicate 满足；失败信息携带已收到的全文。 */
export class SseClient {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  text = "";

  constructor(response: Response) {
    if (response.body === null) throw new Error("SSE response has no body");
    this.reader = response.body.getReader();
  }

  async waitFor(predicate: (text: string) => boolean, timeoutMs = 3_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.text)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`SSE timeout; received so far:\n${this.text}`);
      }
      const result = await readWithTimeout(this.reader, remaining);
      if (result.done) break;
      this.text += this.decoder.decode(result.value, { stream: true });
    }
    if (!predicate(this.text)) {
      throw new Error(`SSE predicate not met; received so far:\n${this.text}`);
    }
    return this.text;
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

export const makeEvent = (overrides: Partial<EventRecord> & Pick<EventRecord, "eventId" | "type">): EventRecord => ({
  seq: 1,
  occurredAt: "2026-10-20T00:00:00.000Z",
  correlationId: "cor_1",
  payload: {},
  ...overrides,
});

/** SSE frame 的期望文本（与实现无关地按契约 §9 拼装）。 */
export const expectedSseFrame = (event: EventRecord): string =>
  `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify({
    correlationId: event.correlationId,
    occurredAt: event.occurredAt,
    payload: event.payload,
  })}\n\n`;
