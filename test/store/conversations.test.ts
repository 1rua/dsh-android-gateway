import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MessagePart } from "../../src/shared/types.js";
import {
  OrganizationConflictError,
  openAccountStore,
  type AccountStore,
} from "../../src/store/index.js";
import { createTempDir, removeTempDir } from "./helpers.js";

let tempDir: string;
let dbPath: string;
let store: AccountStore | undefined;

beforeEach(() => {
  tempDir = createTempDir("dsh-gateway-conversations-");
  dbPath = join(tempDir, "gateway.db");
  store = openAccountStore(dbPath);
});

afterEach(() => {
  store?.close();
  store = undefined;
  removeTempDir(tempDir);
});

const s = (): AccountStore => {
  if (store === undefined) throw new Error("store not opened");
  return store;
};

const insertConversation = (
  overrides: Partial<Parameters<AccountStore["insertConversation"]>[0]> = {},
) =>
  s().insertConversation({
    conversationId: "conv_1",
    clientConversationId: "cclient_1",
    dshSessionId: "sess_1",
    title: "第一条会话",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    ...overrides,
  });

const messageParts: readonly MessagePart[] = [
  { type: "text", text: "你好" },
  { type: "attachment", attachmentId: "att_1", filename: "a.png", mediaType: "image/png", sizeBytes: 3 },
];

const insertMessage = (overrides: Partial<Parameters<AccountStore["insertMessage"]>[0]> = {}) =>
  s().insertMessage({
    messageId: "msg_1",
    conversationId: "conv_1",
    clientMessageId: "cmsg_1",
    sender: "user",
    text: "你好",
    parts: messageParts,
    status: "queued",
    revision: 1,
    errorCode: null,
    generationId: null,
    dshSeq: null,
    createdAt: "2026-10-20T00:00:01.000Z",
    ...overrides,
  });

describe("会话", () => {
  it("插入即分配快照 revision，按 clientId/主键查找，列表稳定排序", () => {
    const first = insertConversation();
    const second = insertConversation({
      conversationId: "conv_2",
      clientConversationId: "cclient_2",
      dshSessionId: "sess_2",
      updatedAt: "2026-10-20T00:00:05.000Z",
    });

    expect(first.snapshotRevision).toBeGreaterThan(0);
    expect(second.snapshotRevision).toBeGreaterThan(first.snapshotRevision);
    expect(s().getConversation("conv_1")).toEqual(first);
    expect(s().getConversation("missing")).toBeUndefined();
    expect(s().findConversationByClientId("cclient_1")?.conversationId).toBe("conv_1");
    expect(s().findConversationByClientId("missing")).toBeUndefined();

    const listed = s().listConversations();
    expect(listed.map((conversation) => conversation.conversationId)).toEqual(["conv_2", "conv_1"]);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
  });

  it("更新字段、推进快照 revision；空 patch 不推进", () => {
    const created = insertConversation();
    const updated = s().updateConversation("conv_1", {
      title: "改名",
      archived: true,
      dshSessionId: null,
      lastMessageAt: "2026-10-20T00:10:00.000Z",
      updatedAt: "2026-10-20T00:10:00.000Z",
    });
    expect(updated).toMatchObject({
      conversationId: "conv_1",
      title: "改名",
      archived: true,
      dshSessionId: null,
      lastMessageAt: "2026-10-20T00:10:00.000Z",
      updatedAt: "2026-10-20T00:10:00.000Z",
      deleted: false,
    });
    expect(updated!.snapshotRevision).toBeGreaterThan(created.snapshotRevision);
    expect(updated!.createdAt).toBe(created.createdAt);

    const unchanged = s().updateConversation("conv_1", {});
    expect(unchanged).toEqual(updated);

    expect(s().updateConversation("missing", { title: "x" })).toBeUndefined();
  });

  it("写入失败时事务回滚：重复会话不消耗快照 revision", () => {
    insertConversation();
    const observed = s().nextSnapshotRevision();
    // clientConversationId 唯一约束失败：事务内已递增的计数器必须一起回滚。
    expect(() =>
      insertConversation({ conversationId: "conv_dup" }),
    ).toThrow();
    expect(s().nextSnapshotRevision()).toBe(observed + 1);
    expect(s().listConversations()).toHaveLength(1);
  });

  it("nextSnapshotRevision 每次调用严格递增，跨重启继续", () => {
    const a = s().nextSnapshotRevision();
    const b = s().nextSnapshotRevision();
    expect(b).toBe(a + 1);
    s().close();
    store = openAccountStore(dbPath);
    expect(s().nextSnapshotRevision()).toBe(b + 1);
  });
});

describe("消息", () => {
  it("插入、按 clientId / dshSeq 查找，parts 深冻结并按时间升序列出", () => {
    insertConversation();
    const first = insertMessage();
    const second = insertMessage({
      messageId: "msg_2",
      clientMessageId: null,
      sender: "assistant",
      text: "世界",
      status: "completed",
      revision: 2,
      dshSeq: 7,
      createdAt: "2026-10-20T00:00:02.000Z",
    });

    expect(first.updatedAt).toBe(first.createdAt);
    expect(s().getMessage("msg_1")).toEqual(first);
    expect(s().findMessageByClientId("conv_1", "cmsg_1")?.messageId).toBe("msg_1");
    expect(s().findMessageByClientId("conv_1", "missing")).toBeUndefined();
    expect(s().findMessageByDshSeq("conv_1", 7)?.messageId).toBe("msg_2");
    expect(s().findMessageByDshSeq("conv_1", 99)).toBeUndefined();

    const listed = s().listMessages("conv_1");
    expect(listed.map((message) => message.messageId)).toEqual(["msg_1", "msg_2"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.parts)).toBe(true);
    expect(Object.isFrozen(first.parts[0])).toBe(true);
    expect(second.clientMessageId).toBeNull();
  });

  it("更新状态/正文/parts/dshSeq 并保留未提供的字段", () => {
    insertConversation();
    insertMessage();
    const updated = s().updateMessage("msg_1", {
      status: "delivered",
      revision: 2,
      errorCode: null,
      parts: [{ type: "text", text: "改过的正文" }],
      generationId: "gen_1",
      dshSeq: 3,
      updatedAt: "2026-10-20T00:00:09.000Z",
    });
    expect(updated).toMatchObject({
      messageId: "msg_1",
      status: "delivered",
      revision: 2,
      text: "你好",
      generationId: "gen_1",
      dshSeq: 3,
      updatedAt: "2026-10-20T00:00:09.000Z",
    });
    expect(updated!.parts).toEqual([{ type: "text", text: "改过的正文" }]);
    expect(Object.isFrozen(updated!.parts[0])).toBe(true);

    expect(s().updateMessage("missing", { status: "failed" })).toBeUndefined();
    expect(s().updateMessage("msg_1", {})).toEqual(updated);
  });

  it("同一会话内 clientMessageId 唯一；重复插入回滚且不改变已有数据", () => {
    insertConversation();
    insertMessage();
    expect(() => insertMessage({ messageId: "msg_dup" })).toThrow();
    expect(s().listMessages("conv_1")).toHaveLength(1);
    expect(s().getMessage("msg_dup")).toBeUndefined();
  });
});

describe("生成", () => {
  it("插入、按消息/会话查找，活跃列表只含 queued/running", () => {
    insertConversation();
    insertMessage();
    const generation = s().insertGeneration({
      generationId: "gen_1",
      conversationId: "conv_1",
      messageId: "msg_1",
      state: "queued",
      createdAt: "2026-10-20T00:00:02.000Z",
    });
    s().insertGeneration({
      generationId: "gen_2",
      conversationId: "conv_1",
      messageId: "msg_2",
      state: "running",
      createdAt: "2026-10-20T00:00:03.000Z",
    });
    s().insertGeneration({
      generationId: "gen_3",
      conversationId: "conv_1",
      messageId: "msg_3",
      state: "completed",
      createdAt: "2026-10-20T00:00:04.000Z",
    });

    expect(s().getGeneration("gen_1")).toEqual(generation);
    expect(s().getGeneration("missing")).toBeUndefined();
    expect(s().findGenerationByMessage("msg_1")?.generationId).toBe("gen_1");
    expect(s().listActiveGenerations("conv_1").map((item) => item.generationId)).toEqual([
      "gen_1",
      "gen_2",
    ]);

    // 同一消息重试时返回最新一条 generation。
    s().insertGeneration({
      generationId: "gen_4",
      conversationId: "conv_1",
      messageId: "msg_1",
      state: "unknown",
      createdAt: "2026-10-20T00:00:05.000Z",
    });
    expect(s().findGenerationByMessage("msg_1")?.generationId).toBe("gen_4");
  });

  it("更新状态与 endedAt", () => {
    insertConversation();
    insertMessage();
    s().insertGeneration({
      generationId: "gen_1",
      conversationId: "conv_1",
      messageId: "msg_1",
      state: "queued",
      createdAt: "2026-10-20T00:00:02.000Z",
    });
    const updated = s().updateGeneration("gen_1", {
      state: "completed",
      endedAt: "2026-10-20T00:00:08.000Z",
    });
    expect(updated).toMatchObject({ state: "completed", endedAt: "2026-10-20T00:00:08.000Z" });
    expect(s().listActiveGenerations("conv_1")).toEqual([]);
    expect(s().updateGeneration("missing", { state: "failed" })).toBeUndefined();
  });
});

describe("附件", () => {
  const attachmentInput = (overrides: Partial<Parameters<AccountStore["insertAttachment"]>[0]> = {}) => ({
    attachmentId: "att_1",
    clientAttachmentId: "catt_1",
    filename: "a.png",
    mediaType: "image/png",
    sizeBytes: 10,
    sha256: "aa",
    status: "staged" as const,
    storagePath: "/tmp/a.png",
    createdAt: "2026-10-20T00:00:00.000Z",
    expiresAt: "2026-10-20T00:10:00.000Z",
    ...overrides,
  });

  it("插入、按 clientId 查找、更新暂存元数据", () => {
    const attachment = s().insertAttachment(attachmentInput());
    expect(s().getAttachment("att_1")).toEqual(attachment);
    expect(s().getAttachment("missing")).toBeUndefined();
    expect(s().findAttachmentByClientId("catt_1")?.attachmentId).toBe("att_1");
    expect(s().findAttachmentByClientId("missing")).toBeUndefined();

    const updated = s().updateAttachment("att_1", {
      status: "uploaded",
      storagePath: null,
      dshAttachmentId: "dsh_att_1",
      sizeBytes: 12,
      sha256: "bb",
    });
    expect(updated).toMatchObject({
      status: "uploaded",
      storagePath: null,
      dshAttachmentId: "dsh_att_1",
      sizeBytes: 12,
      sha256: "bb",
    });
    expect(s().updateAttachment("missing", { status: "failed" })).toBeUndefined();
  });

  it("过期查询按 ISO 字符串比较，且不重复返回已 expired 的记录", () => {
    s().insertAttachment(attachmentInput());
    s().insertAttachment(
      attachmentInput({
        attachmentId: "att_2",
        clientAttachmentId: "catt_2",
        storagePath: null,
        expiresAt: "2026-10-20T00:05:00.000Z",
      }),
    );
    s().insertAttachment(
      attachmentInput({
        attachmentId: "att_3",
        clientAttachmentId: "catt_3",
        expiresAt: "2026-10-20T00:20:00.000Z",
      }),
    );

    expect(s().listExpiredAttachments("2026-10-20T00:04:59.999Z")).toEqual([]);
    expect(s().listExpiredAttachments("2026-10-20T00:05:00.000Z").map((item) => item.attachmentId)).toEqual([
      "att_2",
    ]);
    expect(s().listExpiredAttachments("2026-10-20T00:15:00.000Z").map((item) => item.attachmentId)).toEqual([
      "att_2",
      "att_1",
    ]);

    s().updateAttachment("att_2", { status: "expired", storagePath: null });
    expect(s().listExpiredAttachments("2026-10-20T00:15:00.000Z").map((item) => item.attachmentId)).toEqual([
      "att_1",
    ]);

    expect(() =>
      s().insertAttachment(attachmentInput({ attachmentId: "att_dup", clientAttachmentId: "catt_1" })),
    ).toThrow();
  });
});

describe("会话组织（organization）", () => {
  const nextOrganization = (
    overrides: Partial<{
      sortMode: "updated-desc" | "custom";
      customOrder: string[];
      folders: { folderId: string; name: string }[];
      assignments: Record<string, string>;
    }> = {},
  ) => ({
    sortMode: "custom" as const,
    customOrder: ["conv_2", "conv_1"],
    folders: [{ folderId: "folder_1", name: "工作" }],
    assignments: { conv_1: "folder_1" },
    ...overrides,
  });

  it("默认 revision 0，CAS 成功时 +1 且完整往返", () => {
    expect(s().getOrganization()).toEqual({
      revision: 0,
      sortMode: "updated-desc",
      customOrder: [],
      folders: [],
      assignments: {},
    });

    const replaced = s().replaceOrganization(0, nextOrganization());
    expect(replaced.revision).toBe(1);
    expect(s().getOrganization()).toEqual(replaced);
    expect(Object.isFrozen(replaced)).toBe(true);
    expect(Object.isFrozen(replaced.customOrder)).toBe(true);
    expect(Object.isFrozen(replaced.folders[0])).toBe(true);
    expect(Object.isFrozen(replaced.assignments)).toBe(true);

    const second = s().replaceOrganization(1, {
      sortMode: "updated-desc",
      customOrder: [],
      folders: [],
      assignments: {},
    });
    expect(second.revision).toBe(2);
    expect(s().getOrganization().sortMode).toBe("updated-desc");
  });

  it("revision 不匹配时抛 OrganizationConflictError 且不写库", () => {
    const replaced = s().replaceOrganization(0, nextOrganization());
    let caught: unknown;
    try {
      s().replaceOrganization(0, nextOrganization({ sortMode: "updated-desc" }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrganizationConflictError);
    const conflict = caught as OrganizationConflictError;
    expect(conflict.expectedRevision).toBe(0);
    expect(conflict.actualRevision).toBe(1);
    expect(s().getOrganization()).toEqual(replaced);
  });

  it("组织变更不推进会话列表快照 revision", () => {
    const conversation = insertConversation();
    s().replaceOrganization(0, nextOrganization({ customOrder: [], folders: [], assignments: {} }));
    expect(s().getConversation("conv_1")?.snapshotRevision).toBe(conversation.snapshotRevision);
  });

  it("返回副本，调用方修改入参不影响库内状态", () => {
    const input = nextOrganization();
    s().replaceOrganization(0, input);
    input.customOrder.push("conv_3");
    input.folders[0]!.name = "被改坏";
    (input.assignments as Record<string, string>).conv_1 = "folder_9";
    const stored = s().getOrganization();
    expect(stored.customOrder).toEqual(["conv_2", "conv_1"]);
    expect(stored.folders[0]!.name).toBe("工作");
    expect(stored.assignments.conv_1).toBe("folder_1");
  });
});
