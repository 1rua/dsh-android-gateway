import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CORE_SCHEMA_HASH, canonicalRequestSignatureInput } from "../../src/protocol/index.js";
import { RequestAuthenticator } from "../../src/auth/authenticator.js";
import { AccountManager } from "../../src/core/accounts.js";
import { AttachmentService } from "../../src/core/attachment-service.js";
import { AuthService } from "../../src/core/auth-service.js";
import { ConversationService } from "../../src/core/conversation-service.js";
import { GatewayEventHub } from "../../src/core/event-hub.js";
import { AndroidGatewayCore } from "../../src/core/gateway.js";
import { NegotiationManager } from "../../src/core/negotiation.js";
import { PairingService } from "../../src/core/pairing-service.js";
import type { DshBridge, DshBridgeEvent } from "../../src/dsh/bridge.js";
import type { DshSessionEvent } from "../../src/dsh/types.js";
import type { RawGatewayRequest } from "../../src/http/contract.js";
import type { JsonObject, VerifiedRequest } from "../../src/shared/types.js";

const MOUNT = "/open-android-intelligence/v2";
const NOW = new Date("2026-10-20T12:00:00.000Z");

interface Harness {
  readonly root: string;
  readonly accounts: AccountManager;
  readonly bridge: FakeBridge;
  readonly core: AndroidGatewayCore;
  readonly authenticator: RequestAuthenticator;
  readonly events: GatewayEventHub;
  readonly conversations: ConversationService;
  readonly devicePrivateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  readonly devicePublicKey: string;
  session: { accessToken: string; accountId: string; deviceId: string; sessionId: string };
  negotiationId: string;
}

class FakeBridge {
  readonly emitted: DshBridgeEvent[] = [];
  readonly prompts: Array<{ sessionId: string; requestId: string; content: readonly unknown[] }> = [];
  readonly renamed: Array<{ sessionId: string; title: string }> = [];
  readonly archived: Array<{ sessionId: string; archived: boolean }> = [];
  surfaceEvents: DshSessionEvent[] = [];
  cancelResult = true;
  cancelled: string[] = [];
  uploadResult: { receiptId: string; attachmentId: string } | undefined = undefined;
  #listeners = new Set<(event: DshBridgeEvent) => void>();
  #sequence = 0;

  availability = { available: true, missing: [] as string[] };

  async createSession(input: { sessionId: string }): Promise<string> {
    return input.sessionId;
  }

  async prompt(input: { sessionId: string; requestId: string; content: readonly unknown[] }): Promise<void> {
    this.prompts.push({ sessionId: input.sessionId, requestId: input.requestId, content: input.content });
  }

  cancel(sessionId: string): boolean {
    this.cancelled.push(sessionId);
    return this.cancelResult;
  }

  async rename(sessionId: string, title: string): Promise<string> {
    this.renamed.push({ sessionId, title });
    return title;
  }

  async readSurface(): Promise<{ events: readonly DshSessionEvent[] }> {
    return { events: this.surfaceEvents };
  }

  async readTitle(): Promise<string | undefined> {
    return undefined;
  }

  async listCommands(): Promise<readonly never[]> {
    return [];
  }

  async uploadFile(): Promise<{ receiptId: string; attachmentId: string } | undefined> {
    return this.uploadResult;
  }

  async setArchived(sessionId: string, archived: boolean): Promise<boolean> {
    this.archived.push({ sessionId, archived });
    return true;
  }

  subscribe(listener: (event: DshBridgeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#listeners.clear();
  }

  emit(event: DshBridgeEvent): void {
    this.emitted.push(event);
    for (const listener of this.#listeners) listener(event);
  }

  nextSeq(): number {
    this.#sequence += 1;
    return this.#sequence;
  }
}

const asBridge = (fake: FakeBridge): DshBridge => fake as unknown as DshBridge;

const makeHarness = async (): Promise<Harness> => {
  const root = mkdtempSync(join(tmpdir(), "dsh-android-gateway-test-"));
  const accounts = new AccountManager({
    rootDir: root,
    configuredAccounts: [{ username: "alice", password: "correct horse battery staple" }],
  });
  await accounts.initialize();
  const bridge = new FakeBridge();
  const events = new GatewayEventHub({
    openStore: (accountId) => accounts.openStore(accountId),
    retentionSeconds: 86_400,
  });
  const negotiations = new NegotiationManager({
    deploymentId: () => accounts.deploymentId(),
    limits: {
      attachmentTtlSeconds: 3600,
      eventRetentionSeconds: 86_400,
      maxClockSkewSeconds: 120,
    },
    tlsSpkiSha256: null,
    now: () => NOW.getTime(),
  });
  const auth = new AuthService({ accounts, negotiations, now: () => NOW.getTime() });
  const attachments = new AttachmentService({
    accounts,
    bridge: asBridge(bridge),
    ttlSeconds: 3600,
    maxBytes: 10 * 1024 * 1024,
    now: () => NOW.getTime(),
  });
  const pairing = new PairingService({ accounts, events });
  const conversations = new ConversationService({
    accounts,
    events,
    bridge: asBridge(bridge),
    attachments,
    workspace: "/workspace",
    now: () => NOW.getTime(),
  });
  conversations.start();
  const core = new AndroidGatewayCore({
    accounts,
    negotiations,
    auth,
    conversations,
    attachments,
    pairing,
    events,
    now: () => NOW.getTime(),
  });
  const authenticator = new RequestAuthenticator({
    openStore: (accountId) => accounts.openStore(accountId),
    options: { maxClockSkewMs: 120_000, now: () => NOW.getTime() },
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const harness: Harness = {
    root,
    accounts,
    bridge,
    core,
    authenticator,
    events,
    conversations,
    devicePrivateKey: privateKey,
    devicePublicKey: jwk.x,
    session: { accessToken: "", accountId: "", deviceId: "", sessionId: "" },
    negotiationId: `neg_${randomBytes(8).toString("hex")}`,
  };
  return harness;
};

const preAuthRequest = (target: string, body: JsonObject): RawGatewayRequest => {
  const text = JSON.stringify(body);
  return {
    method: "POST",
    target: `${MOUNT}${target}`,
    headers: [
      { name: "Content-Type", value: "application/json" },
      { name: "Accept", value: "application/json" },
    ],
    body: Buffer.from(text, "utf8"),
    bodyText: text,
    json: body,
  };
};

const signedRequest = (
  harness: Harness,
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
  target: string,
  body: JsonObject | null,
): RawGatewayRequest => {
  const bodyText = body === null ? "" : JSON.stringify(body);
  const bodyBytes = Buffer.from(bodyText, "utf8");
  const requestId = `req_${randomBytes(10).toString("hex")}`;
  const timestamp = new Date(NOW.getTime()).toISOString();
  const nonce = randomBytes(16).toString("base64url");
  const preimage = canonicalRequestSignatureInput({
    method,
    target: `${MOUNT}${target}`,
    accountId: harness.session.accountId,
    deviceId: harness.session.deviceId,
    sessionId: harness.session.sessionId,
    requestId,
    timestamp,
    nonce,
    body: bodyBytes,
  });
  const signature = sign(null, Buffer.from(preimage), harness.devicePrivateKey).toString("base64url");
  const headers = [
    { name: "Authorization", value: `Bearer ${harness.session.accessToken}` },
    { name: "X-Open-Android-Intelligence-Protocol", value: "2.1" },
    { name: "X-Open-Android-Intelligence-Account", value: harness.session.accountId },
    { name: "X-Open-Android-Intelligence-Device", value: harness.session.deviceId },
    { name: "X-Open-Android-Intelligence-Session", value: harness.session.sessionId },
    { name: "X-Open-Android-Intelligence-Request-Id", value: requestId },
    { name: "X-Open-Android-Intelligence-Timestamp", value: timestamp },
    { name: "X-Open-Android-Intelligence-Nonce", value: nonce },
    { name: "X-Open-Android-Intelligence-Signature", value: signature },
  ];
  if (method !== "GET") headers.push({ name: "Idempotency-Key", value: requestId });
  if (body !== null) headers.push({ name: "Content-Type", value: "application/json" });
  return {
    method,
    target: `${MOUNT}${target}`,
    headers,
    body: bodyBytes,
    bodyText,
    json: body,
  };
};

const authenticate = async (
  harness: Harness,
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
  target: string,
  body: JsonObject | null = null,
): Promise<VerifiedRequest> => harness.authenticator.verify(signedRequest(harness, method, target, body));

const login = async (harness: Harness): Promise<void> => {
  const negotiated = await harness.core.negotiate(
    preAuthRequest("/negotiate", {
      negotiationId: harness.negotiationId,
      protocol: { major: 2, minor: 1 },
      client: {
        installationId: "install_test",
        appVersion: "2.1.0",
        platform: "android",
        platformApi: 35,
      },
      features: {
        auth: ["password", "refresh"],
        messages: ["chat-v1"],
        attachments: ["staged-sha256-v1"],
        events: ["sse-cursor-v1"],
        deviceRequests: ["risk-queue-v1"],
        conversationUi: [
          "agent-command-catalog-v1",
          "generation-cancel-v1",
          "newline-v1",
          "conversation-management-v1",
        ],
      },
      schemaHashes: { core: CORE_SCHEMA_HASH },
    }),
  );
  expect(negotiated.status).toBe(200);

  const loginResult = await harness.core.passwordLogin(
    preAuthRequest("/sessions/password", {
      negotiationId: harness.negotiationId,
      username: "alice",
      password: "correct horse battery staple",
      installation: {
        installationId: "install_test",
        displayName: "Test phone",
        devicePublicKey: harness.devicePublicKey,
      },
    }),
  );
  const data = loginResult.data as Record<string, string>;
  harness.session = {
    accessToken: data.accessToken!,
    accountId: data.accountId!,
    deviceId: data.deviceId!,
    sessionId: data.sessionId!,
  };
};

const assistantMessage = (
  text: string,
  seq: number,
  time: number,
): DshSessionEvent => ({
  type: "assistant/message",
  seq,
  time,
  data: {
    turn: 1,
    step: 0,
    message: {
      id: `assistant_${seq}`,
      role: "assistant",
      content: [{ type: "text", text }],
      source: { kind: "model" },
    },
    stream: [],
  },
});

const userMessage = (text: string, seq: number, time: number): DshSessionEvent => ({
  type: "user/message",
  seq,
  time,
  data: {
    id: `user_${seq}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  },
});

describe("AndroidGatewayCore 闭环", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
    await login(harness);
  });

  afterEach(() => {
    harness.conversations.stop();
    harness.accounts.close();
  });

  it("密码登录返回完整会话凭据", () => {
    expect(harness.session.accountId).toMatch(/^acct_/);
    expect(harness.session.deviceId).toMatch(/^dev_/);
    expect(harness.session.sessionId).toMatch(/^sess_/);
    expect(harness.session.accessToken.length).toBeGreaterThan(20);
  });

  it("创建会话、发送消息、流式增量、完成与历史", async () => {
    const created = await harness.core.handle(
      await authenticate(harness, "POST", "/conversations", {
        clientConversationId: "cconv_1",
        title: "测试会话",
      }),
    );
    const conversation = (created.data as { conversation: { conversationId: string } }).conversation;
    const conversationId = conversation.conversationId;
    expect(conversationId).toMatch(/^conv_/);

    const sent = await harness.core.handle(
      await authenticate(harness, "POST", `/conversations/${conversationId}/messages`, {
        clientMessageId: "cmsg_1",
        text: "你好",
        attachments: [],
      }),
    );
    const message = (sent.data as {
      message: { status: string; messageId: string; generationId?: string };
    }).message;
    expect(message.status).toBe("accepted");
    expect(message.generationId).toMatch(/^gen_/);
    expect(harness.bridge.prompts).toHaveLength(1);
    const sessionId = harness.bridge.prompts[0]!.sessionId;

    const start = harness.bridge.nextSeq();
    harness.bridge.emit({
      kind: "session",
      sessionId,
      event: { type: "turn/start", seq: start, time: NOW.getTime(), data: { turn: 1 } },
    });
    const userSeq = harness.bridge.nextSeq();
    harness.bridge.emit({
      kind: "session",
      sessionId,
      event: userMessage("你好", userSeq, NOW.getTime()),
    });
    harness.bridge.emit({
      kind: "stream",
      sessionId,
      frame: {
        type: "chunk",
        attemptId: "attempt_1",
        revision: 1,
        index: 0,
        time: NOW.getTime(),
        chunk: { type: "text-delta", index: 0, text: "你" },
      },
    });
    harness.bridge.emit({
      kind: "stream",
      sessionId,
      frame: {
        type: "chunk",
        attemptId: "attempt_1",
        revision: 2,
        index: 1,
        time: NOW.getTime(),
        chunk: { type: "text-delta", index: 0, text: "好！" },
      },
    });
    const assistantSeq = harness.bridge.nextSeq();
    harness.bridge.surfaceEvents = [
      userMessage("你好", userSeq, NOW.getTime()),
      assistantMessage("你好！", assistantSeq, NOW.getTime()),
    ];
    harness.bridge.emit({
      kind: "session",
      sessionId,
      event: assistantMessage("你好！", assistantSeq, NOW.getTime()),
    });
    const endSeq = harness.bridge.nextSeq();
    harness.bridge.emit({
      kind: "session",
      sessionId,
      event: {
        type: "turn/end",
        seq: endSeq,
        time: NOW.getTime(),
        data: { turn: 1, reason: { kind: "completed" } },
      },
    });

    // 等待异步事件处理完成
    await new Promise((resolve) => setTimeout(resolve, 20));

    const current = await harness.core.handle(
      await authenticate(harness, "GET", `/conversations/${conversationId}/generations/current`),
    );
    expect((current.data as { generation: unknown }).generation).toBeNull();

    const history = await harness.core.handle(
      await authenticate(harness, "GET", `/conversations/${conversationId}/messages?limit=20`),
    );
    const messages = (history.data as { messages: Array<{ sender: string; text: string }> }).messages;
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]!.sender).toBe("user");
    expect(messages.some((entry) => entry.sender === "assistant" && entry.text === "你好！")).toBe(true);

    const store = harness.accounts.openStore(harness.session.accountId)!;
    const conversationRecord = store.getConversation(conversationId)!;
    const replay = store.listEventsAfter(0, 100);
    const types = replay.map((event) => event.type);
    expect(types).toContain("conversation.message.status");
    expect(types).toContain("conversation.message.delta");
    expect(types).toContain("conversation.message.completed");
    const statuses = replay
      .filter((event) => event.type === "conversation.message.status")
      .map((event) => (event.payload as { status: string }).status);
    expect(statuses[0]).toBe("queued");
    expect(statuses).toContain("delivered");
    expect(statuses).toContain("completed");
    expect(conversationRecord.lastMessageAt).not.toBeNull();
  });

  it("停止生成调用宿主取消并返回 CANCELLED", async () => {
    const created = await harness.core.handle(
      await authenticate(harness, "POST", "/conversations", { clientConversationId: "cconv_2" }),
    );
    const conversationId = (created.data as { conversation: { conversationId: string } }).conversation
      .conversationId;
    const sent = await harness.core.handle(
      await authenticate(harness, "POST", `/conversations/${conversationId}/messages`, {
        clientMessageId: "cmsg_2",
        text: "写一篇长文",
        attachments: [],
      }),
    );
    const generationId = (sent.data as { message: { generationId: string } }).message.generationId;
    const sessionId = harness.bridge.prompts[0]!.sessionId;
    harness.bridge.emit({
      kind: "session",
      sessionId,
      event: { type: "turn/start", seq: harness.bridge.nextSeq(), time: NOW.getTime(), data: { turn: 1 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cancelled = await harness.core.handle(
      await authenticate(harness, "POST", `/conversations/${conversationId}/generations/${generationId}/cancel`, {
        clientMessageId: "cancel_1",
      }),
    );
    expect((cancelled.data as { outcome: string }).outcome).toBe("CANCELLED");
    expect(harness.bridge.cancelled).toContain(sessionId);
  });

  it("附件创建、上传、提交后可作为消息附件发送", async () => {
    const created = await harness.core.handle(
      await authenticate(harness, "POST", "/conversations", { clientConversationId: "cconv_3" }),
    );
    const conversationId = (created.data as { conversation: { conversationId: string } }).conversation
      .conversationId;
    const payload = Buffer.from("hello attachment", "utf8");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(payload).digest("hex");
    const attachmentCreated = await harness.core.handle(
      await authenticate(harness, "POST", "/attachments", {
        clientAttachmentId: "catt_1",
        filename: "note.txt",
        mediaType: "text/plain",
        sizeBytes: payload.length,
        sha256: sha,
      }),
    );
    const attachmentId = (attachmentCreated.data as {
      attachment: { attachmentId: string; status: string };
    }).attachment.attachmentId;
    expect((attachmentCreated.data as { attachment: { status: string } }).attachment.status).toBe("staged");

    const tmpFile = join(harness.root, "upload.bin");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(tmpFile, payload);
    const uploaded = await harness.core.uploadAttachmentContent(
      await authenticate(harness, "PUT", `/attachments/${attachmentId}/content`),
      { filePath: tmpFile, contentLength: payload.length, sha256Hex: sha },
    );
    expect((uploaded.data as { attachment: { status: string } }).attachment.status).toBe("uploaded");

    const committed = await harness.core.handle(
      await authenticate(harness, "POST", `/attachments/${attachmentId}/commit`, {}),
    );
    expect((committed.data as { attachment: { status: string } }).attachment.status).toBe("uploaded");

    harness.bridge.uploadResult = { receiptId: "receipt_1", attachmentId: "dsh_file_1" };
    const sent = await harness.core.handle(
      await authenticate(harness, "POST", `/conversations/${conversationId}/messages`, {
        clientMessageId: "cmsg_3",
        text: "",
        attachments: [{ attachmentId }],
      }),
    );
    expect((sent.data as { message: { status: string } }).message.status).toBe("accepted");
    expect(harness.bridge.prompts.at(-1)?.content).toHaveLength(1);
  });

  it("配对状态可轮询、能力发布摘要与 App 算法一致", async () => {
    const current = await harness.core.handle(await authenticate(harness, "GET", "/pairings/current"));
    const data = current.data as { grantRevision: number; grantDigest: string | null };
    expect(data.grantRevision).toBe(1);
    expect(data.grantDigest).toBeNull();

    const published = await harness.core.handle(
      await authenticate(harness, "POST", "/pairings/current/capabilities", {
        bindings: [],
        localGrantRevision: 1,
        expectedGrantRevision: 1,
      }),
    );
    const digest = (published.data as { grantDigest: string }).grantDigest;
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const again = await harness.core.handle(await authenticate(harness, "GET", "/pairings/current"));
    expect((again.data as { grantRevision: number }).grantRevision).toBe(2);
    expect((again.data as { grantDigest: string }).grantDigest).toBe(digest);
  });

  it("非法签名被拒绝", async () => {
    const request = signedRequest(harness, "GET", "/conversations", null);
    const tampered = {
      ...request,
      headers: request.headers.map((header) =>
        header.name === "X-Open-Android-Intelligence-Signature"
          ? { ...header, value: Buffer.alloc(64).toString("base64url") }
          : header,
      ),
    };
    await expect(harness.authenticator.verify(tampered)).rejects.toMatchObject({
      code: "SIGNATURE_INVALID",
    });
  });
});
