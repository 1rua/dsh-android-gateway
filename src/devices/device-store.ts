import { chmodSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";

import type { JsonObject, JsonValue } from "../shared/types.js";
import type {
  CapabilityRisk,
  DeviceRequestRecord,
  DeviceRequestState,
} from "./contract.js";

/** 当前 schema 版本；每次破坏性变更递增并追加一条迁移。 */
const SCHEMA_VERSION = 2;
const BUSY_TIMEOUT_MS = 5_000;

/** 仍可能收到 result / expire 的非终态集合（与契约 §10 的状态机一致）。 */
export const ACTIVE_DEVICE_REQUEST_STATES = ["pending", "claimed", "cancel_requested"] as const;
export type ActiveDeviceRequestState = (typeof ACTIVE_DEVICE_REQUEST_STATES)[number];

const STATE_LIST_SQL = ACTIVE_DEVICE_REQUEST_STATES.map((state) => `'${state}'`).join(", ");

/**
 * 建表迁移（v1）。
 *
 * 设计要点：
 * - 每账号一个独立数据库文件，`accountId` 由调用方在路径与传输层绑定，行内不再重复；
 * - `device_requests` 保存 `DeviceRequestRecord` 的全部字段；claim 幂等所需的
 *   `claim_id` 与最小审计时间单独成列；
 * - waker（等待 Promise 的解析器）只活在进程内，绝不落库；
 * - 时间字段统一 TEXT（RFC 3339 UTC 毫秒），可直接按字典序比较；
 * - STRICT 表让 SQLite 兜住基础类型错误。
 */
const MIGRATION_V1 = `
CREATE TABLE device_requests (
  request_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  pairing_generation INTEGER NOT NULL,
  capability_id TEXT NOT NULL,
  capability_version TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  author_key_id TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('read', 'sync', 'write', 'high-privilege-ephemeral')),
  grant_revision INTEGER NOT NULL,
  requires_foreground_confirmation INTEGER NOT NULL
    CHECK (requires_foreground_confirmation IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'claimed', 'cancel_requested',
    'succeeded', 'failed', 'denied', 'cancelled', 'expired', 'outcome_unknown'
  )),
  claim_id TEXT,
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  settled_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_device_requests_device_state
  ON device_requests(device_id, state, created_at, request_id);
CREATE INDEX idx_device_requests_expiry
  ON device_requests(state, expires_at);
`;

/** v2：把最近一次能力发布快照持久化，Gateway 重启后仍能被工具发现。 */
const MIGRATION_V2 = `
CREATE TABLE IF NOT EXISTS capability_publication (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  publication_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`;

const MIGRATIONS: readonly { readonly version: number; readonly sql: string }[] = [
  { version: 1, sql: MIGRATION_V1 },
  { version: 2, sql: MIGRATION_V2 },
];

interface DeviceRequestRow {
  request_id: string;
  conversation_id: string;
  device_id: string;
  pairing_generation: number;
  capability_id: string;
  capability_version: string;
  plugin_id: string;
  author_key_id: string;
  parameters_json: string;
  risk: CapabilityRisk;
  grant_revision: number;
  requires_foreground_confirmation: number;
  state: DeviceRequestState;
  claim_id: string | null;
  result_json: string | null;
  error_code: string | null;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  settled_at: string | null;
  updated_at: string;
}

type SqlRow = Record<string, SQLOutputValue>;

const rowOf = <T>(row: SqlRow | undefined): T | undefined => row as unknown as T | undefined;

/** 深冻结：存储读取必须返回不可变快照，避免调用方改到内部状态。 */
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
};

const corrupt = (detail: string): Error => new Error(`STORE_CORRUPT:${detail}`);

const stringifyJson = (value: unknown, label: string): string => {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error(`STORE_INVALID:${label} is not JSON serializable`);
  return json;
};

const parseJson = (json: string, label: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw corrupt(`${label} is not valid JSON`);
  }
};

const parseJsonObject = (json: string, label: string): JsonObject => {
  const parsed = parseJson(json, label);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw corrupt(`${label} must be a JSON object`);
  }
  return deepFreeze(parsed as JsonObject);
};

const parseJsonValue = (json: string, label: string): JsonValue => {
  const parsed = parseJson(json, label);
  return deepFreeze(parsed as JsonValue);
};

/** 请求不存在（与状态冲突区分开，便于业务层选择不同的错误码）。 */
export class DeviceRequestNotFoundError extends Error {
  readonly requestId: string;

  constructor(requestId: string) {
    super(`DEVICE_REQUEST_NOT_FOUND:${requestId}`);
    this.name = "DeviceRequestNotFoundError";
    this.requestId = requestId;
  }
}

/** 乐观并发冲突：事务内读到的状态已不是调用方期望的状态。 */
export class DeviceRequestStateConflictError extends Error {
  readonly requestId: string;
  readonly expectedState: DeviceRequestState;
  readonly actualState: DeviceRequestState;

  constructor(requestId: string, expectedState: DeviceRequestState, actualState: DeviceRequestState) {
    super(
      `DEVICE_REQUEST_STATE_CONFLICT: expected ${expectedState}, actual ${actualState}`,
    );
    this.name = "DeviceRequestStateConflictError";
    this.requestId = requestId;
    this.expectedState = expectedState;
    this.actualState = actualState;
  }
}

/** 一次原子状态迁移要写入的字段；未提供的字段保持原值。 */
export interface DeviceRequestTransition {
  readonly state: DeviceRequestState;
  readonly claimId?: string | null;
  readonly result?: JsonValue;
  readonly errorCode?: string | null;
  readonly claimedAt?: string;
  readonly settledAt?: string;
  readonly updatedAt: string;
}

/**
 * 单账号设备请求存储（`node:sqlite` 的同步 `DatabaseSync`）。
 *
 * 约定：
 * - 数据库文件路径由调用方传入（建议 `<accountDir>/device-requests.db`），目录已存在
 *   且为 0700 由调用方保证；
 * - 开启 WAL；每个写操作都在 `BEGIN IMMEDIATE` 事务中完成，失败回滚；
 * - 状态迁移使用 `WHERE request_id = ? AND state = ?` 的 CAS 更新，防止并发覆盖；
 * - 读取返回深冻结的新对象，与内部行数据完全解耦；
 * - `close()` 幂等。
 */
export class DeviceRequestStore {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #transactionDepth = 0;
  #closed = false;

  constructor(databasePath: string) {
    this.#db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: false });
    try {
      this.#configureDatabase();
      this.#migrate();
    } catch (error) {
      try {
        this.#db.close();
      } catch {
        // 构造失败时的关闭失败不掩盖原始异常。
      }
      throw error;
    }
    this.#restrictFilePermissions(databasePath);
  }

  // ---------------------------------------------------------------------------
  // 生命周期与基础设施
  // ---------------------------------------------------------------------------

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    this.#db.close();
  }

  #configureDatabase(): void {
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = OFF");
  }

  #migrate(): void {
    const current = this.#userVersion();
    if (current > SCHEMA_VERSION) {
      throw new Error(`STORE_SCHEMA_UNSUPPORTED: database version ${current} > ${SCHEMA_VERSION}`);
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.#transaction(() => {
        this.#db.exec(migration.sql);
        this.#db.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }

  #userVersion(): number {
    const row = rowOf<{ user_version: number }>(
      this.#db.prepare("PRAGMA user_version").get() as SqlRow | undefined,
    );
    return row?.user_version ?? 0;
  }

  #restrictFilePermissions(databasePath: string): void {
    if (databasePath === ":memory:" || databasePath.startsWith("file:")) return;
    for (const path of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      `${databasePath}-journal`,
    ]) {
      try {
        chmodSync(path, 0o600);
      } catch {
        // 文件可能尚未创建，或平台不支持 POSIX 权限：尽力而为，不阻断打开。
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("STORE_CLOSED: the device-request store has been closed");
  }

  #stmt(sql: string): StatementSync {
    this.#assertOpen();
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #transaction<T>(operation: () => T): T {
    this.#assertOpen();
    if (this.#transactionDepth > 0) {
      this.#transactionDepth += 1;
      try {
        return operation();
      } finally {
        this.#transactionDepth -= 1;
      }
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#transactionDepth = 1;
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // 事务可能已被 SQLite 自动回滚；保留原始异常。
      }
      throw error;
    } finally {
      this.#transactionDepth = 0;
    }
  }

  #changes(result: { changes: number | bigint }): number {
    return Number(result.changes);
  }

  // ---------------------------------------------------------------------------
  // 读写
  // ---------------------------------------------------------------------------

  /** 插入一条新的 `pending` 请求；`request_id` 冲突由 SQLite 主键拒绝。 */
  insert(record: DeviceRequestRecord): DeviceRequestRecord {
    return this.#transaction(() => {
      this.#stmt(
        `INSERT INTO device_requests
           (request_id, conversation_id, device_id, pairing_generation,
            capability_id, capability_version, plugin_id, author_key_id,
            parameters_json, risk, grant_revision, requires_foreground_confirmation,
            state, claim_id, result_json, error_code, created_at, expires_at,
            claimed_at, settled_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, ?)`,
      ).run(
        record.requestId,
        record.conversationId,
        record.deviceId,
        record.pairingGeneration,
        record.capability.id,
        record.capability.version,
        record.provider.pluginId,
        record.provider.authorKeyId,
        stringifyJson(record.parameters, "device_requests.parameters_json"),
        record.risk,
        record.grantRevision,
        record.requiresForegroundConfirmation ? 1 : 0,
        record.state,
        record.createdAt,
        record.expiresAt,
        record.createdAt,
      );
      return this.#require(record.requestId);
    });
  }

  get(requestId: string): DeviceRequestRecord | undefined {
    const row = rowOf<DeviceRequestRow>(
      this.#stmt("SELECT * FROM device_requests WHERE request_id = ?").get(requestId),
    );
    return row === undefined ? undefined : this.#fromRow(row);
  }

  /**
   * 原子状态迁移：仅当当前状态等于 `expectedState` 时写入，否则抛
   * `DeviceRequestStateConflictError`，由业务层重新读取后判断幂等还是非法迁移。
   */
  transition(
    requestId: string,
    expectedState: DeviceRequestState,
    patch: DeviceRequestTransition,
  ): DeviceRequestRecord {
    return this.#transaction(() => {
      const current = this.#readRow(requestId);
      if (current === undefined) throw new DeviceRequestNotFoundError(requestId);
      if (current.state !== expectedState) {
        throw new DeviceRequestStateConflictError(requestId, expectedState, current.state);
      }
      const assignments: string[] = ["state = ?"];
      const params: SQLInputValue[] = [patch.state];
      if (patch.claimId !== undefined) {
        assignments.push("claim_id = ?");
        params.push(patch.claimId);
      }
      if (patch.result !== undefined) {
        assignments.push("result_json = ?");
        params.push(stringifyJson(patch.result, "device_requests.result_json"));
      }
      if (patch.errorCode !== undefined) {
        assignments.push("error_code = ?");
        params.push(patch.errorCode);
      }
      if (patch.claimedAt !== undefined) {
        assignments.push("claimed_at = ?");
        params.push(patch.claimedAt);
      }
      if (patch.settledAt !== undefined) {
        assignments.push("settled_at = ?");
        params.push(patch.settledAt);
      }
      assignments.push("updated_at = ?");
      params.push(patch.updatedAt);
      params.push(requestId, expectedState);
      const result = this.#stmt(
        `UPDATE device_requests SET ${assignments.join(", ")}
         WHERE request_id = ? AND state = ?`,
      ).run(...params);
      if (this.#changes(result) !== 1) {
        // 事务内状态不会并发变化（DatabaseSync 同步、BEGIN IMMEDIATE 串行），
        // 走到这里说明行在读取后被同进程其它路径改写；保守地重新读取并报告。
        const latest = this.#readRow(requestId);
        if (latest === undefined) throw new DeviceRequestNotFoundError(requestId);
        throw new DeviceRequestStateConflictError(requestId, expectedState, latest.state);
      }
      return this.#require(requestId);
    });
  }

  /** 某设备所有非终态请求，按创建时间升序（供 App 重连恢复与诊断）。 */
  listActiveForDevice(deviceId: string): readonly DeviceRequestRecord[] {
    const rows = this.#stmt(
      `SELECT * FROM device_requests
       WHERE device_id = ? AND state IN (${STATE_LIST_SQL})
       ORDER BY created_at ASC, request_id ASC`,
    ).all(deviceId) as SqlRow[];
    return Object.freeze(rows.map((row) => this.#fromRow(rowOf<DeviceRequestRow>(row)!)));
  }

  /** 某设备仍处于 `pending`（尚未被 claim）的请求 ID，按创建时间升序。 */
  listPendingForDevice(deviceId: string): readonly string[] {
    const rows = this.#stmt(
      `SELECT request_id FROM device_requests
       WHERE device_id = ? AND state = 'pending'
       ORDER BY created_at ASC, request_id ASC`,
    ).all(deviceId) as SqlRow[];
    return Object.freeze(
      rows.map((row) => {
        const requestId = rowOf<{ request_id: string }>(row)?.request_id;
        if (typeof requestId !== "string") throw corrupt("device_requests.request_id must be a string");
        return requestId;
      }),
    );
  }

  /** 到期且仍可迁移的非终态请求，按到期时间升序。 */
  listExpired(nowIso: string): readonly DeviceRequestRecord[] {
    const rows = this.#stmt(
      `SELECT * FROM device_requests
       WHERE state IN (${STATE_LIST_SQL}) AND expires_at <= ?
       ORDER BY expires_at ASC, request_id ASC`,
    ).all(nowIso) as SqlRow[];
    return Object.freeze(rows.map((row) => this.#fromRow(rowOf<DeviceRequestRow>(row)!)));
  }

  // ---------------------------------------------------------------------------
  // 能力发布快照
  // ---------------------------------------------------------------------------

  /** 保存最近一次能力发布（单行 upsert）；绑定校验由服务层完成。 */
  savePublication(publication: JsonObject): void {
    this.#transaction(() => {
      const updatedAt =
        typeof publication.updatedAt === "string"
          ? publication.updatedAt
          : new Date().toISOString();
      this.#stmt(
        `INSERT INTO capability_publication (id, publication_json, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           publication_json = excluded.publication_json,
           updated_at = excluded.updated_at`,
      ).run(stringifyJson(publication, "capability_publication.publication_json"), updatedAt);
    });
  }

  /** 读取最近一次能力发布；从未发布时返回 undefined。 */
  loadPublication(): JsonObject | undefined {
    const row = rowOf<{ publication_json: string }>(
      this.#stmt("SELECT publication_json FROM capability_publication WHERE id = 1").get(),
    );
    if (row === undefined) return undefined;
    return parseJsonObject(row.publication_json, "capability_publication.publication_json");
  }

  // ---------------------------------------------------------------------------
  // 行映射
  // ---------------------------------------------------------------------------

  #readRow(requestId: string): DeviceRequestRow | undefined {
    return rowOf<DeviceRequestRow>(
      this.#stmt("SELECT * FROM device_requests WHERE request_id = ?").get(requestId),
    );
  }

  #require(requestId: string): DeviceRequestRecord {
    const row = this.#readRow(requestId);
    if (row === undefined) throw corrupt(`device_requests row ${requestId} missing after write`);
    return this.#fromRow(row);
  }

  #fromRow(row: DeviceRequestRow): DeviceRequestRecord {
    return deepFreeze({
      requestId: row.request_id,
      conversationId: row.conversation_id,
      deviceId: row.device_id,
      pairingGeneration: row.pairing_generation,
      capability: Object.freeze({ id: row.capability_id, version: row.capability_version }),
      provider: Object.freeze({ pluginId: row.plugin_id, authorKeyId: row.author_key_id }),
      parameters: parseJsonObject(row.parameters_json, "device_requests.parameters_json"),
      risk: row.risk,
      grantRevision: row.grant_revision,
      requiresForegroundConfirmation: row.requires_foreground_confirmation !== 0,
      state: row.state,
      claimId: row.claim_id,
      result: row.result_json === null ? null : parseJsonValue(row.result_json, "device_requests.result_json"),
      errorCode: row.error_code,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    });
  }
}

/** 打开（或首次创建）一个账号的设备请求数据库。 */
export const openDeviceRequestStore = (databasePath: string): DeviceRequestStore =>
  new DeviceRequestStore(databasePath);
