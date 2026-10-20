import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IdempotencyRecord } from "../../src/shared/types.js";
import { openAccountStore, type AccountStore } from "../../src/store/index.js";
import { createTempDir, removeTempDir } from "./helpers.js";

let tempDir: string;
let dbPath: string;
let store: AccountStore | undefined;

beforeEach(() => {
  tempDir = createTempDir("dsh-gateway-store-");
  dbPath = join(tempDir, "gateway.db");
});

afterEach(() => {
  closeStore();
  removeTempDir(tempDir);
});

/** 打开本用例的账号库；同一用例内重复调用会先关掉上一个连接。 */
const useStore = (): AccountStore => {
  closeStore();
  store = openAccountStore(dbPath);
  return store;
};

const closeStore = (): void => {
  store?.close();
  store = undefined;
};

/** 构造合法的设备插入入参。 */
const deviceInput = (overrides: Partial<Parameters<AccountStore["insertDevice"]>[0]> = {}) => ({
  deviceId: "dev_1",
  installationId: "install_1",
  publicKey: "pk_1",
  displayName: "Pixel",
  pairingId: "pair_1",
  pairingGeneration: 1,
  pairedAt: "2026-10-20T00:00:00.000Z",
  ...overrides,
});

describe("SQLite 建库与迁移", () => {
  it("首次打开创建 v1 schema，WAL 与 user_version 正确落盘，重启后数据仍在", () => {
    const first = useStore();
    const device = first.insertDevice(deviceInput());
    const firstRevision = first.nextSnapshotRevision();
    const event = first.appendEvent({
      eventId: "evt_1",
      type: "gateway.notice",
      payload: { noticeCode: "HELLO" },
      occurredAt: "2026-10-20T00:00:00.000Z",
      correlationId: "cor_1",
    });
    expect(event.seq).toBe(1);
    closeStore();

    // 用独立连接检查迁移结果与 WAL 模式（此时 store 已关闭，不存在双写）。
    const raw = new DatabaseSync(dbPath);
    try {
      expect(raw.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
      expect(raw.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
      const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => String(row.name));
      for (const table of [
        "access_sessions",
        "attachments",
        "conversations",
        "counters",
        "devices",
        "events",
        "generations",
        "idempotency",
        "messages",
        "nonces",
        "organization",
        "refresh_credentials",
      ]) {
        expect(tables).toContain(table);
      }
    } finally {
      raw.close();
    }

    const second = useStore();
    expect(second.getDevice(device.deviceId)).toEqual(device);
    expect(second.latestEventSeq()).toBe(1);
    expect(second.nextSnapshotRevision()).toBe(firstRevision + 1);

    if (process.platform !== "win32") {
      // 数据库文件必须收紧到 0600（目录 0700 由调用方保证）。
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    }
  });

  it("支持 :memory: 数据库并安全重复 close", () => {
    const memory = openAccountStore(":memory:");
    const device = memory.insertDevice(deviceInput({ deviceId: "dev_mem" }));
    expect(memory.getDevice(device.deviceId)).toEqual(device);
    memory.close();
    expect(() => memory.close()).not.toThrow();
  });

  it("拒绝比当前实现更新的数据库版本", () => {
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => openAccountStore(dbPath)).toThrow(/STORE_SCHEMA_UNSUPPORTED/);
  });
});

describe("设备、refresh 凭据与 access session", () => {
  it("设备 CRUD、配对代数与撤销时间保持首次值", () => {
    const s = useStore();
    const first = s.insertDevice(deviceInput());
    const second = s.insertDevice(
      deviceInput({
        deviceId: "dev_2",
        installationId: "install_2",
        pairedAt: "2026-10-20T00:00:01.000Z",
      }),
    );

    expect(s.getDevice("dev_1")).toEqual(first);
    expect(s.getDevice("missing")).toBeUndefined();
    expect(s.listDevices().map((device) => device.deviceId)).toEqual(["dev_1", "dev_2"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(s.listDevices())).toBe(true);

    expect(s.bumpPairingGeneration("dev_1", 5)?.pairingGeneration).toBe(5);
    expect(s.bumpPairingGeneration("missing", 2)).toBeUndefined();

    s.revokeDevice("dev_1", "2026-10-20T01:00:00.000Z");
    expect(s.getDevice("dev_1")?.revokedAt).toBe("2026-10-20T01:00:00.000Z");
    // 第二次撤销不得覆盖第一次的审计时间。
    s.revokeDevice("dev_1", "2026-10-21T00:00:00.000Z");
    expect(s.getDevice("dev_1")?.revokedAt).toBe("2026-10-20T01:00:00.000Z");
    expect(second.revokedAt).toBeNull();

    expect(() => s.insertDevice(deviceInput({ deviceId: "dev_1" }))).toThrow();
    expect(s.listDevices()).toHaveLength(2);
  });

  it("refresh 凭据按摘要查找、设备级撤销并返回影响行数", () => {
    const s = useStore();
    const c1 = s.insertRefreshCredential({
      credentialHash: "hash_1",
      deviceId: "dev_1",
      installationId: "install_1",
      createdAt: "2026-10-20T00:00:00.000Z",
    });
    s.insertRefreshCredential({
      credentialHash: "hash_2",
      deviceId: "dev_1",
      installationId: "install_1",
      createdAt: "2026-10-20T00:00:01.000Z",
    });
    s.insertRefreshCredential({
      credentialHash: "hash_3",
      deviceId: "dev_2",
      installationId: "install_2",
      createdAt: "2026-10-20T00:00:02.000Z",
    });

    expect(s.findRefreshCredential("hash_1")).toEqual(c1);
    expect(s.findRefreshCredential("missing")).toBeUndefined();

    s.revokeRefreshCredential("hash_1", "2026-10-20T02:00:00.000Z");
    expect(s.findRefreshCredential("hash_1")?.revokedAt).toBe("2026-10-20T02:00:00.000Z");
    // 已撤销的 credential 不重复计数。
    expect(s.revokeRefreshCredentialsForDevice("dev_1", "2026-10-20T03:00:00.000Z")).toBe(1);
    expect(s.revokeRefreshCredentialsForDevice("dev_1", "2026-10-20T04:00:00.000Z")).toBe(0);
    expect(s.findRefreshCredential("hash_2")?.revokedAt).toBe("2026-10-20T03:00:00.000Z");
    expect(s.findRefreshCredential("hash_3")?.revokedAt).toBeNull();

    expect(() =>
      s.insertRefreshCredential({
        credentialHash: "hash_1",
        deviceId: "dev_1",
        installationId: "install_1",
        createdAt: "2026-10-20T05:00:00.000Z",
      }),
    ).toThrow();
  });

  it("access session 的按 token/session 查找、撤销与过期清理", () => {
    const s = useStore();
    const expired = s.insertAccessSession({
      sessionId: "sess_expired",
      tokenHash: "token_expired",
      deviceId: "dev_1",
      createdAt: "2026-10-20T00:00:00.000Z",
      expiresAt: "2026-10-20T00:10:00.000Z",
    });
    const active = s.insertAccessSession({
      sessionId: "sess_active",
      tokenHash: "token_active",
      deviceId: "dev_1",
      createdAt: "2026-10-20T00:00:00.000Z",
      expiresAt: "2026-10-20T01:00:00.000Z",
    });

    expect(s.findAccessSessionByTokenHash("token_expired")).toEqual(expired);
    expect(s.findAccessSession("sess_active")).toEqual(active);
    expect(s.findAccessSession("missing")).toBeUndefined();
    expect(s.findAccessSessionByTokenHash("missing")).toBeUndefined();

    s.revokeAccessSession("sess_expired", "2026-10-20T00:20:00.000Z");
    expect(s.findAccessSession("sess_expired")?.revokedAt).toBe("2026-10-20T00:20:00.000Z");

    // 只清除过期（expires_at <= now）的行，未过期且已撤销的仍保留审计。
    expect(s.pruneExpiredAccessSessions("2026-10-20T00:30:00.000Z")).toBe(1);
    expect(s.findAccessSession("sess_expired")).toBeUndefined();
    expect(s.findAccessSession("sess_active")).toEqual(active);

    expect(s.revokeAccessSessionsForDevice("dev_1", "2026-10-20T00:40:00.000Z")).toBe(1);
    expect(s.findAccessSession("sess_active")?.revokedAt).toBe("2026-10-20T00:40:00.000Z");
    expect(s.revokeAccessSessionsForDevice("dev_1", "2026-10-20T00:50:00.000Z")).toBe(0);
  });

  it("nonce 记录幂等，过期后清理", () => {
    const s = useStore();
    expect(s.hasNonce("nonce_1")).toBe(false);
    s.recordNonce("nonce_1", "2026-10-20T00:10:00.000Z");
    expect(s.hasNonce("nonce_1")).toBe(true);
    // 同一 nonce 重复记录不抛错（重放判定在 hasNonce）。
    expect(() => s.recordNonce("nonce_1", "2026-10-20T00:20:00.000Z")).not.toThrow();

    s.recordNonce("nonce_2", "2026-10-20T00:05:00.000Z");
    expect(s.pruneNonces("2026-10-20T00:06:00.000Z")).toBe(1);
    expect(s.hasNonce("nonce_2")).toBe(false);
    expect(s.hasNonce("nonce_1")).toBe(true);
  });
});

describe("事件流", () => {
  const append = (
    s: AccountStore,
    eventId: string,
    occurredAt: string,
    payload: Record<string, string | number> = { noticeCode: eventId },
  ) =>
    s.appendEvent({
      eventId,
      type: "gateway.notice",
      payload,
      occurredAt,
      correlationId: `cor_${eventId}`,
    });

  it("seq 单调递增、升序分页、冻结 payload 并在裁剪后继续增长", () => {
    const s = useStore();
    const e1 = append(s, "evt_1", "2026-10-20T00:00:01.000Z");
    const e2 = append(s, "evt_2", "2026-10-20T00:00:02.000Z");
    const e3 = append(s, "evt_3", "2026-10-20T00:00:03.000Z");

    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
    expect(s.latestEventSeq()).toBe(3);
    expect(s.oldestEventSeq()).toBe(1);
    expect(s.findEventByEventId("evt_2")).toEqual(e2);

    expect(Object.isFrozen(e2)).toBe(true);
    expect(Object.isFrozen(e2.payload)).toBe(true);

    expect(s.listEventsAfter(0, 10).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(s.listEventsAfter(1, 1).map((event) => event.seq)).toEqual([2]);
    expect(s.listEventsAfter(3, 10)).toEqual([]);
    expect(s.listEventsAfter(0, 0)).toEqual([]);
    expect(s.listEventsAfter(0, -5)).toEqual([]);

    // 写后修改调用方 payload 不得影响库内快照。
    const callerPayload: Record<string, string> = { mutable: "before" };
    append(s, "evt_4", "2026-10-20T00:00:04.000Z", callerPayload);
    callerPayload.mutable = "after";
    expect(s.findEventByEventId("evt_4")?.payload.mutable).toBe("before");

    // 裁剪 00:00:02 之前（严格小于）的事件；重复 eventId 触发约束失败且不回滚已提交数据。
    expect(s.pruneEvents("2026-10-20T00:00:02.000Z")).toBe(1);
    expect(s.oldestEventSeq()).toBe(2);
    expect(s.latestEventSeq()).toBe(4);

    expect(() => append(s, "evt_3", "2026-10-20T00:00:05.000Z")).toThrow();
    const e5 = append(s, "evt_5", "2026-10-20T00:00:05.000Z");
    expect(e5.seq).toBe(5);
    expect(s.latestEventSeq()).toBe(5);

    // 即使事件被全部裁剪，AUTOINCREMENT 也不会复用旧 seq。
    expect(s.pruneEvents("2099-01-01T00:00:00.000Z")).toBe(4);
    expect(s.latestEventSeq()).toBe(0);
    expect(s.oldestEventSeq()).toBeNull();
    const e6 = append(s, "evt_6", "2026-10-20T00:00:06.000Z");
    expect(e6.seq).toBe(6);
  });

  it("空事件流时 latestEventSeq 为 0、oldestEventSeq 为 null", () => {
    const s = useStore();
    expect(s.latestEventSeq()).toBe(0);
    expect(s.oldestEventSeq()).toBeNull();
    expect(s.listEventsAfter(0, 10)).toEqual([]);
  });
});

describe("幂等账本", () => {
  it("按 (scope, requestId) 精确读写，冲突时保留首次终态", () => {
    const s = useStore();
    const record: IdempotencyRecord = {
      scope: "acct_1:conversation.create",
      requestId: "req_1",
      fingerprint: "sha256:aaa",
      responseJson: '{"ok":true}',
      createdAt: "2026-10-20T00:00:00.000Z",
    };
    s.saveIdempotency(record);
    const found = s.findIdempotency(record.scope, record.requestId);
    expect(found).toEqual(record);
    expect(Object.isFrozen(found)).toBe(true);
    expect(s.findIdempotency(record.scope, "req_missing")).toBeUndefined();

    // 同键不同指纹：不覆盖原记录，由上层比较 fingerprint 后返回 IDEMPOTENCY_CONFLICT。
    s.saveIdempotency({
      ...record,
      fingerprint: "sha256:bbb",
      responseJson: '{"ok":false}',
      createdAt: "2026-10-20T00:10:00.000Z",
    });
    const after = s.findIdempotency(record.scope, record.requestId);
    expect(after?.fingerprint).toBe("sha256:aaa");
    expect(after?.responseJson).toBe('{"ok":true}');
    expect(after?.createdAt).toBe("2026-10-20T00:00:00.000Z");

    // 不同 scope 的相同 requestId 互不影响。
    s.saveIdempotency({ ...record, scope: "other", fingerprint: "sha256:ccc" });
    expect(s.findIdempotency("other", "req_1")?.fingerprint).toBe("sha256:ccc");
  });
});
