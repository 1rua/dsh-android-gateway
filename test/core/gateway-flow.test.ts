import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CORE_SCHEMA_HASH, canonicalRequestSignatureInput } from "../../src/protocol/index.js";
import { RequestAuthenticator } from "../../src/auth/authenticator.js";
import { AccountManager } from "../../src/core/accounts.js";
import { AttachmentService } from "../../src/core/attachment-service.js";
import { BatchStore } from "../../src/core/batch-store.js";
import { AuthService } from "../../src/core/auth-service.js";
import { ConversationService } from "../../src/core/conversation-service.js";
import { GatewayEventHub } from "../../src/core/event-hub.js";
import { AndroidGatewayCore } from "../../src/core/gateway.js";
import { NegotiationManager } from "../../src/core/negotiation.js";
import { PairingService } from "../../src/core/pairing-service.js";
import { ApprovalService } from "../../src/core/approval-service.js";
import type { DeviceCapabilityServiceApi } from "../../src/devices/contract.js";
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
  readonly approval: ApprovalService;
  readonly deviceState: {
    readonly published: Array<Record<string, unknown>>;
    pending: string[];
    detailPayload: Record<string, unknown>;
    claimPayload: Record<string, unknown>;
    resultPayload: Record<string, unknown>;
  };
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
  commandResult: { kind: "success" | "error"; text?: string } | undefined = undefined;
  readonly storedImages = new Map<string, { bytes: Uint8Array; mediaType: string; name?: string }>();
  readonly storedFiles = new Map<string, Uint8Array>();
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

  async executeCommand(
    _sessionId: string,
    _line: string,
  ): Promise<{ result: { kind: "success" | "error"; text?: string } } | undefined> {
    return this.commandResult === undefined ? undefined : { result: this.commandResult };
  }

  async uploadFile(): Promise<{ receiptId: string; attachmentId: string } | undefined> {
    return this.uploadResult;
  }

  async saveImage(
    data: Uint8Array,
    mediaType: string,
    name?: string,
  ): Promise<{ attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }> {
    const { createHash } = await import("node:crypto");
    const attachmentId = `sha256:${createHash("sha256").update(data).digest("hex")}`;
    this.storedImages.set(attachmentId, { bytes: data, mediaType, ...(name === undefined ? {} : { name }) });
    return {
      attachmentId,
      mediaType,
      bytes: data.length,
      width: 64,
      height: 64,
      ...(name === undefined ? {} : { name }),
    };
  }

  async readImage(ref: { attachmentId: string }): Promise<{ ref: unknown; data: Uint8Array }> {
    const stored = this.storedImages.get(ref.attachmentId);
    if (stored === undefined) throw new Error("IMAGE_NOT_FOUND");
    return { ref, data: stored.bytes };
  }

  async *readFile(ref: { attachmentId: string }): AsyncGenerator<Uint8Array> {
    const data = this.storedFiles.get(ref.attachmentId);
    if (data === undefined) throw new Error("FILE_NOT_FOUND");
    yield data;
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
  const deviceState = {
    published: [] as Array<Record<string, unknown>>,
    pending: [] as string[],
    detailPayload: { request: { requestId: "dreq_1", state: "pending" } } as Record<string, unknown>,
    claimPayload: {
      claimId: "claim_1",
      requestId: "dreq_1",
      accountId: "",
      deviceId: "",
      pairingGeneration: 1,
      grantRevision: 1,
    } as Record<string, unknown>,
    resultPayload: {} as Record<string, unknown>,
  };
  const devices: DeviceCapabilityServiceApi = {
    publish(_accountId, publication) {
      deviceState.published.push(publication as unknown as Record<string, unknown>);
    },
    publication() {
      return undefined;
    },
    async createRequest() {
      throw new Error("not used");
    },
    claim(_request, requestId) {
      return { ...deviceState.claimPayload, requestId } as ReturnType<DeviceCapabilityServiceApi["claim"]>;
    },
    submitResult() {
      return {
        requestId: "dreq_1",
        conversationId: "conv_1",
        deviceId: "dev_1",
        pairingGeneration: 1,
        capability: { id: "cap", version: "1" },
        provider: { pluginId: "plugin", authorKeyId: "sha256:" + "a".repeat(64) },
        parameters: {},
        risk: "read",
        grantRevision: 1,
        requiresForegroundConfirmation: false,
        state: "succeeded",
        claimId: "claim_1",
        result: { outcome: "succeeded" },
        errorCode: null,
        createdAt: NOW.toISOString(),
        expiresAt: NOW.toISOString(),
      } as ReturnType<DeviceCapabilityServiceApi["submitResult"]>;
    },
    detail(_request, requestId) {
      return { ...deviceState.detailPayload, request: { ...(deviceState.detailPayload.request as object), requestId } };
    },
    pendingForDevice() {
      return deviceState.pending;
    },
    cancel() {},
    expireDue() {
      return 0;
    },
    close() {},
  };
  const pairing = new PairingService({ accounts, events, devices });
  const approval = new ApprovalService({
    accounts,
    events,
    findConversation: (sessionId) => conversations.conversationForSession(sessionId),
    now: () => NOW.getTime(),
  });
  const conversations = new ConversationService({
    accounts,
    events,
    bridge: asBridge(bridge),
    attachments,
    batchStore: new BatchStore(accounts),
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
    approval,
    devices,
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
    approval,
    deviceState,
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


  it("消息批次：成员独立、Agent 收到聚合输入、历史带 batchId", async () => {
    const created = await harness.core.handle(
      await authenticate(harness, "POST", "/conversations", { clientConversationId: "cconv_batch" }),
    );
    const conversationId = (created.data as { conversation: { conversationId: string } }).conversation
      .conversationId;
    const response = await harness.core.handle(
      await authenticate(harness, "POST", `/conversations/${conversationId}/message-batches`, {
        clientBatchId: "batch_client_1",
        clientConversationId: conversationId,
        joinMode: "newline-v1",
        members: [
          { clientMessageId: "cmsg_b1", text: "第一行" },
          { clientMessageId: "cmsg_b2", text: "第二行" },
        ],
      }),
    );
    const data = response.data as {
      batchId: string;
      status: string;
      generationId: string;
      members: Array<{ clientMessageId: string; messageId: string }>;
    };
    expect(data.status).toBe("accepted");
    expect(data.batchId).toMatch(/^batch_/);
    expect(data.members).toHaveLength(2);
    expect(harness.bridge.prompts.at(-1)?.content.map((part) => (part as { text?: string }).text).filter(Boolean).join("")).toBe(
      "第一行\n第二行",
    );
    const sessionId = harness.bridge.prompts.at(-1)!.sessionId;
    harness.bridge.emit({
      kind: "session",
      sessionId,
      event: { type: "turn/start", seq: harness.bridge.nextSeq(), time: NOW.getTime(), data: { turn: 1 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const store = harness.accounts.openStore(harness.session.accountId)!;
    for (const member of data.members) {
      expect(store.getMessage(member.messageId)?.status).toBe("delivered");
    }
    harness.bridge.emit({
      kind: "session",
      sessionId,
      event: {
        type: "turn/end",
        seq: harness.bridge.nextSeq(),
        time: NOW.getTime(),
        data: { turn: 1, reason: { kind: "completed" } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const history = await harness.core.handle(
      await authenticate(harness, "GET", `/conversations/${conversationId}/messages?limit=20`),
    );
    const messages = (history.data as { messages: Array<{ messageId: string; batchId?: string; sender: string }> }).messages;
    const batchMembers = messages.filter((message) => message.batchId === data.batchId);
    expect(batchMembers).toHaveLength(2);
    for (const message of batchMembers) {
      expect(store.getMessage(message.messageId)?.status).toBe("completed");
    }
  });

  it("/new 创建新会话并发出 conversation.command.result", async () => {
    const created = await harness.core.handle(
      await authenticate(harness, "POST", "/conversations", { clientConversationId: "cconv_new" }),
    );
    const sourceId = (created.data as { conversation: { conversationId: string } }).conversation.conversationId;
    const store = harness.accounts.openStore(harness.session.accountId)!;
    const before = store.listConversations().length;
    const sent = await harness.core.handle(
      await authenticate(harness, "POST", `/conversations/${sourceId}/messages`, {
        clientMessageId: "cmsg_new",
        text: "/new",
        attachments: [],
      }),
    );
    expect((sent.data as { message: { status: string } }).message.status).toBe("accepted");
    expect(harness.bridge.prompts).toHaveLength(0);
    expect(store.listConversations().length).toBe(before + 1);
    const result = [...store.listEventsAfter(0, 1000)].reverse().find(
      (event) => event.type === "conversation.command.result",
    );
    expect(result).toBeDefined();
    expect((result?.payload as { outcome: string }).outcome).toBe("created-conversation");
    expect(store.getConversation(String((result?.payload as { conversationId: string }).conversationId))).toBeDefined();
  });

  it("能力发布持久化、设备请求路由与基线快照 pending 列表", async () => {
    const negotiation = await harness.core.negotiate(
      preAuthRequest("/negotiate", {
        negotiationId: "neg_device",
        protocol: { major: 2, minor: 1 },
        client: { installationId: "install_device", appVersion: "2.1.1", platform: "android", platformApi: 35 },
        features: {
          auth: ["password", "refresh"],
          messages: ["chat-v1"],
          attachments: ["staged-sha256-v1"],
          events: ["sse-cursor-v1"],
          deviceRequests: ["risk-queue-v1"],
          conversationUi: [],
        },
        schemaHashes: { core: CORE_SCHEMA_HASH },
      }),
    );
    expect(negotiation.status).toBe(200);
    const login = await harness.core.passwordLogin(
      preAuthRequest("/sessions/password", {
        negotiationId: "neg_device",
        username: "alice",
        password: "correct horse battery staple",
        installation: {
          installationId: "install_device",
          displayName: "device phone",
          devicePublicKey: harness.devicePublicKey,
        },
      }),
    );
    const data = login.data as Record<string, string>;
    harness.session = {
      accessToken: data.accessToken!,
      accountId: data.accountId!,
      deviceId: data.deviceId!,
      sessionId: data.sessionId!,
    };
    const published = await harness.core.handle(
      await authenticate(harness, "POST", "/pairings/current/capabilities", {
        bindings: [
          {
            pluginId: "org.example.phone",
            authorKeyId: "sha256:" + "b".repeat(64),
            capabilityId: "notifications.query",
            capabilityVersion: "1.0.0",
            schemaSha256: "sha256:" + "c".repeat(64),
            schema: { type: "object" },
            risk: "read",
          },
        ],
        localGrantRevision: 1,
        expectedGrantRevision: 1,
        inventory: [],
      }),
    );
    expect((published.data as { grantRevision: number }).grantRevision).toBe(2);
    expect(harness.deviceState.published).toHaveLength(1);
    const state = harness.accounts.readPairingState(harness.session.accountId);
    expect(state.capabilities?.bindings).toHaveLength(1);
    expect(state.capabilities?.deviceId).toBe(harness.session.deviceId);

    const detail = await harness.core.handle(
      await authenticate(harness, "GET", "/device-requests/dreq_1"),
    );
    expect((detail.data as { request: { requestId: string } }).request.requestId).toBe("dreq_1");
    const claim = await harness.core.handle(
      await authenticate(harness, "POST", "/device-requests/dreq_1/claim", { grantRevision: 2 }),
    );
    expect((claim.data as { claimId: string }).claimId).toBe("claim_1");
    await harness.core.handle(
      await authenticate(harness, "POST", "/device-requests/dreq_1/result", {
        claimId: "claim_1",
        grantRevision: 2,
        result: { outcome: "succeeded", data: { ok: true } },
      }),
    );
    harness.deviceState.pending = ["dreq_2"];
    const snapshot = await harness.core.handle(
      await authenticate(harness, "GET", "/sync/snapshot"),
    );
    expect((snapshot.data as { pendingDeviceRequests: string[] }).pendingDeviceRequests).toEqual(["dreq_2"]);
  });

  it("斜杠命令由宿主执行并以 assistant 消息返回输出", async () => {
    const created = await harness.core.handle(
      await authenticate(harness, "POST", "/conversations", { clientConversationId: "cconv_cmd" }),
    );
    const conversationId = (created.data as { conversation: { conversationId: string } }).conversation
      .conversationId;
    harness.bridge.commandResult = { kind: "success", text: "preset workspace-write" };
    const sent = await harness.core.handle(
      await authenticate(harness, "POST", `/conversations/${conversationId}/messages`, {
        clientMessageId: "cmsg_cmd",
        text: "/permission workspace-write",
        attachments: [],
      }),
    );
    expect((sent.data as { message: { status: string } }).message.status).toBe("accepted");
    expect(harness.bridge.prompts).toHaveLength(0);
    const store = harness.accounts.openStore(harness.session.accountId)!;
    const messages = store.listMessages(conversationId);
    const assistant = messages.find((message) => message.sender === "assistant");
    expect(assistant?.text).toBe("preset workspace-write");
    const user = messages.find((message) => message.sender === "user");
    expect(user?.status).toBe("completed");
  });

  it("审批卡片：下发一次档位、决策落定、重复决策 409", async () => {
    const created = await harness.core.handle(
      await authenticate(harness, "POST", "/conversations", { clientConversationId: "cconv_approval" }),
    );
    const conversationId = (created.data as { conversation: { conversationId: string } }).conversation
      .conversationId;
    const store = harness.accounts.openStore(harness.session.accountId)!;
    const sessionId = store.getConversation(conversationId)!.dshSessionId!;
    const outcomePromise = harness.approval.handle(
      { agent: { session: { id: sessionId } }, toolName: "bash", reason: "需要确认" },
      async () => "unavailable",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const requested = [...store.listEventsAfter(0, 1000)]
      .reverse()
      .find((event) => event.type === "conversation.approval.requested");
    expect(requested).toBeDefined();
    const approvalId = String((requested?.payload as { approvalId: string }).approvalId);
    expect((requested?.payload as { conversationId: string }).conversationId).toBe(conversationId);
    expect((requested?.payload as { options: unknown[] }).options).toHaveLength(2);
    const decided = await harness.core.handle(
      await authenticate(harness, "POST", `/approvals/${approvalId}/decisions`, { decision: "once" }),
    );
    expect((decided.data as { approval: { decision: string } }).approval.decision).toBe("once");
    await expect(outcomePromise).resolves.toBe("allowed-once");
    await expect(
      harness.core.handle(
        await authenticate(harness, "POST", `/approvals/${approvalId}/decisions`, { decision: "deny" }),
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_ALREADY_RESOLVED" });
  });

  it("历史媒体：metadata/cache-grant/content 可回读宿主原件", async () => {
    const created = await harness.core.handle(
      await authenticate(harness, "POST", "/conversations", { clientConversationId: "cconv_media" }),
    );
    const conversationId = (created.data as { conversation: { conversationId: string } }).conversation
      .conversationId;
    const payload = Buffer.from("history media bytes", "utf8");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(payload).digest("hex");
    const attachmentCreated = await harness.core.handle(
      await authenticate(harness, "POST", "/attachments", {
        clientAttachmentId: "catt_media",
        filename: "media.txt",
        mediaType: "text/plain",
        sizeBytes: payload.length,
        sha256: sha,
      }),
    );
    const attachmentId = (attachmentCreated.data as { attachment: { attachmentId: string } }).attachment.attachmentId;
    const tmpFile = join(harness.root, "media.bin");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(tmpFile, payload);
    await harness.core.uploadAttachmentContent(
      await authenticate(harness, "PUT", `/attachments/${attachmentId}/content`),
      { filePath: tmpFile, contentLength: payload.length, sha256Hex: sha },
    );
    await harness.core.handle(
      await authenticate(harness, "POST", `/attachments/${attachmentId}/commit`, {}),
    );
    harness.bridge.uploadResult = { receiptId: "receipt_media", attachmentId: "dsh_media_1" };
    harness.bridge.storedFiles.set("dsh_media_1", payload);
    await harness.core.handle(
      await authenticate(harness, "POST", `/conversations/${conversationId}/messages`, {
        clientMessageId: "cmsg_media",
        text: "",
        attachments: [{ attachmentId }],
      }),
    );
    const metadata = await harness.core.handle(
      await authenticate(
        harness,
        "GET",
        `/conversations/${conversationId}/attachments/${attachmentId}/metadata?format=stream-v1`,
      ),
    );
    expect((metadata.data as { metadata: { remoteAvailable: boolean } }).metadata.remoteAvailable).toBe(true);
    const grant = await harness.core.handle(
      await authenticate(
        harness,
        "POST",
        `/conversations/${conversationId}/attachments/${attachmentId}/cache-grant`,
        {},
      ),
    );
    const grantId = (grant.data as { grantId: string }).grantId;
    expect(grantId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const content = await harness.core.handle(
      await authenticate(
        harness,
        "GET",
        `/conversations/${conversationId}/attachments/${attachmentId}/content?format=stream-v1&grantId=${grantId}`,
      ),
    );
    expect(Buffer.from((content.data as { contentBase64: string }).contentBase64, "base64").toString("utf8")).toBe(
      "history media bytes",
    );
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
