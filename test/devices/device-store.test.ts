import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DeviceRequestStateConflictError,
  DeviceRequestStore,
} from "../../src/devices/device-store.js";
import type { DeviceRequestRecord } from "../../src/devices/contract.js";
import { createTempDir, removeTempDir } from "../store/helpers.js";
import { makeStoredRecord } from "./helpers.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");

let rootDir: string;
let dbPath: string;

beforeEach(() => {
  rootDir = createTempDir("device-store-");
  dbPath = join(rootDir, "device-requests.db");
});

afterEach(() => {
  removeTempDir(rootDir);
});

const open = (): DeviceRequestStore => new DeviceRequestStore(dbPath);

const insertPending = (
  store: DeviceRequestStore,
  requestId = "dreq_1",
  overrides: Partial<DeviceRequestRecord> = {},
): DeviceRequestRecord =>
  store.insert(
    makeStoredRecord({
      requestId,
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
      ...overrides,
    }),
  );

describe("DeviceRequestStore", () => {
  it("插入后返回深冻结快照，并按设备与状态查询", () => {
    const store = open();
    try {
      const record = insertPending(store);
      expect(record.requestId).toBe("dreq_1");
      expect(record.state).toBe("pending");
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.capability)).toBe(true);
      expect(Object.isFrozen(record.provider)).toBe(true);
      expect(Object.isFrozen(record.parameters)).toBe(true);

      expect(store.get("dreq_1")).toEqual(record);
      expect(store.get("missing")).toBeUndefined();
      expect(store.listPendingForDevice("dev_test")).toEqual(["dreq_1"]);
      expect(store.listPendingForDevice("dev_other")).toEqual([]);
      expect(store.listActiveForDevice("dev_test")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("状态迁移使用 CAS，期望状态不符时抛冲突且不写入", () => {
    const store = open();
    try {
      insertPending(store);
      const claimed = store.transition("dreq_1", "pending", {
        state: "claimed",
        claimId: "claim_1",
        claimedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
      expect(claimed.state).toBe("claimed");
      expect(claimed.claimId).toBe("claim_1");

      expect(() =>
        store.transition("dreq_1", "pending", {
          state: "cancelled",
          updatedAt: NOW.toISOString(),
        }),
      ).toThrow(DeviceRequestStateConflictError);

      expect(store.get("dreq_1")?.state).toBe("claimed");
    } finally {
      store.close();
    }
  });

  it("终态结果以 JSON 保存，重开数据库后仍可读取", () => {
    const first = open();
    insertPending(first);
    first.transition("dreq_1", "pending", {
      state: "claimed",
      claimId: "claim_1",
      updatedAt: NOW.toISOString(),
    });
    const result = { outcome: "succeeded" as const, data: { threads: 2 } };
    first.transition("dreq_1", "claimed", {
      state: "succeeded",
      result,
      errorCode: null,
      settledAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    first.close();

    const reopened = open();
    try {
      const record = reopened.get("dreq_1");
      expect(record?.state).toBe("succeeded");
      expect(record?.result).toEqual(result);
      expect(Object.isFrozen(record?.result)).toBe(true);
      expect(reopened.listActiveForDevice("dev_test")).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("listExpired 只返回仍可迁移的到期请求", () => {
    const store = open();
    try {
      insertPending(store, "dreq_due", {
        expiresAt: new Date(NOW.getTime() - 1).toISOString(),
      });
      insertPending(store, "dreq_future", {
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      });
      insertPending(store, "dreq_settled", {
        expiresAt: new Date(NOW.getTime() - 1).toISOString(),
      });
      store.transition("dreq_settled", "pending", {
        state: "cancelled",
        updatedAt: NOW.toISOString(),
      });

      const due = store.listExpired(NOW.toISOString());
      expect(due.map((record) => record.requestId)).toEqual(["dreq_due"]);
      expect(store.listActiveForDevice("dev_test").map((record) => record.requestId)).toEqual([
        "dreq_due",
        "dreq_future",
      ]);
    } finally {
      store.close();
    }
  });


  it("启用 WAL 并收紧数据库文件权限", () => {
    const store = open();
    try {
      insertPending(store);
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  });

  it("请求不存在时抛 DeviceRequestNotFoundError 语义的异常", () => {
    const store = open();
    try {
      expect(() =>
        store.transition("missing", "pending", {
          state: "cancelled",
          updatedAt: NOW.toISOString(),
        }),
      ).toThrow(/DEVICE_REQUEST_NOT_FOUND/);
    } finally {
      store.close();
    }
  });
});
