import { chmodSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";

import type {
  AccessSessionRecord,
  AttachmentRecord,
  AttachmentStatus,
  ConversationFolder,
  ConversationRecord,
  DeviceRecord,
  EventRecord,
  GenerationRecord,
  IdempotencyRecord,
  JsonObject,
  MessagePart,
  MessageRecord,
  MessageStatus,
  OrganizationRecord,
  RefreshCredentialRecord,
} from "../shared/types.js";
import type {
  AccountStore,
  AppendEventInput,
  AttachmentPatch,
  ConversationPatch,
  GenerationPatch,
  InsertAccessSessionInput,
  InsertAttachmentInput,
  InsertConversationInput,
  InsertDeviceInput,
  InsertGenerationInput,
  InsertMessageInput,
  InsertRefreshCredentialInput,
  MessagePatch,
  OpenAccountStore,
} from "./contract.js";

/** 当前 schema 版本；每次破坏性变更递增并追加一条迁移。 */
const SCHEMA_VERSION = 1;
/** 会话列表快照 revision 的计数器名（与组织 revision 相互独立）。 */
const SNAPSHOT_COUNTER = "conversation_snapshot_revision";
const BUSY_TIMEOUT_MS = 5_000;

/**
 * 建表迁移（v1）。
 *
 * 设计要点：
 * - 全部使用 STRICT 表，SQLite 负责基础类型校验；
 * - 不声明外键：解绑/删号是资源级事务，历史审计行需要保留，跨表引用完整性由本层
 *   的写事务保证（构造时也会显式关闭 SQLite 默认打开的外键检查）；
 * - 时间字段一律 TEXT，ISO 8601 UTC 毫秒字符串可直接按字典序比较；
 * - 索引覆盖列表、过期清理与按幂等键/游标查询这些热路径。
 */
const MIGRATION_V1 = `
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  pairing_id TEXT NOT NULL,
  pairing_generation INTEGER NOT NULL,
  paired_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE TABLE refresh_credentials (
  credential_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE INDEX idx_refresh_credentials_device ON refresh_credentials(device_id);

CREATE TABLE access_sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE INDEX idx_access_sessions_device ON access_sessions(device_id);
CREATE INDEX idx_access_sessions_expires ON access_sessions(expires_at);

CREATE TABLE nonces (
  nonce TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_nonces_expires ON nonces(expires_at);

CREATE TABLE idempotency (
  scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, request_id)
) STRICT;

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL
) STRICT;
CREATE INDEX idx_events_occurred ON events(occurred_at);

CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  client_conversation_id TEXT NOT NULL UNIQUE,
  dsh_session_id TEXT,
  title TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT,
  snapshot_revision INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_conversations_list ON conversations(updated_at DESC, conversation_id ASC);

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  client_message_id TEXT,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  parts_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'completed', 'failed')),
  revision INTEGER NOT NULL,
  error_code TEXT,
  generation_id TEXT,
  dsh_seq INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX uq_messages_client ON messages(conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at, message_id);
CREATE INDEX idx_messages_dsh_seq ON messages(conversation_id, dsh_seq);

CREATE TABLE generations (
  generation_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
  created_at TEXT NOT NULL,
  ended_at TEXT
) STRICT;
CREATE INDEX idx_generations_conversation ON generations(conversation_id, state);
CREATE INDEX idx_generations_message ON generations(message_id);

CREATE TABLE attachments (
  attachment_id TEXT PRIMARY KEY,
  client_attachment_id TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'uploaded', 'failed', 'expired')),
  storage_path TEXT,
  dsh_attachment_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_attachments_expires ON attachments(status, expires_at);

CREATE TABLE organization (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  sort_mode TEXT NOT NULL CHECK (sort_mode IN ('updated-desc', 'custom')),
  custom_order_json TEXT NOT NULL,
  folders_json TEXT NOT NULL,
  assignments_json TEXT NOT NULL
) STRICT;

INSERT INTO organization (id, revision, sort_mode, custom_order_json, folders_json, assignments_json)
VALUES (1, 0, 'updated-desc', '[]', '[]', '{}');

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;

INSERT INTO counters (name, value) VALUES ('${SNAPSHOT_COUNTER}', 0);
`;

/** 迁移列表；按 version 升序执行，写在同一个 BEGIN IMMEDIATE 事务里。 */
const MIGRATIONS: readonly { readonly version: number; readonly sql: string }[] = [
  { version: 1, sql: MIGRATION_V1 },
];

interface DeviceRow {
  device_id: string;
  installation_id: string;
  public_key: string;
  display_name: string;
  pairing_id: string;
  pairing_generation: number;
  paired_at: string;
  revoked_at: string | null;
}

interface RefreshCredentialRow {
  credential_hash: string;
  device_id: string;
  installation_id: string;
  created_at: string;
  revoked_at: string | null;
}

interface AccessSessionRow {
  session_id: string;
  token_hash: string;
  device_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface IdempotencyRow {
  scope: string;
  request_id: string;
  fingerprint: string;
  response_json: string;
  created_at: string;
}

interface EventRow {
  seq: number;
  event_id: string;
  type: string;
  payload_json: string;
  occurred_at: string;
  correlation_id: string;
}

interface ConversationRow {
  conversation_id: string;
  client_conversation_id: string;
  dsh_session_id: string | null;
  title: string | null;
  archived: number;
  deleted: number;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  snapshot_revision: number;
}

interface MessageRow {
  message_id: string;
  conversation_id: string;
  client_message_id: string | null;
  sender: string;
  text: string;
  parts_json: string;
  status: MessageStatus;
  revision: number;
  error_code: string | null;
  generation_id: string | null;
  dsh_seq: number | null;
  created_at: string;
  updated_at: string;
}

interface GenerationRow {
  generation_id: string;
  conversation_id: string;
  message_id: string;
  state: GenerationRecord["state"];
  created_at: string;
  ended_at: string | null;
}

interface AttachmentRow {
  attachment_id: string;
  client_attachment_id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  status: AttachmentStatus;
  storage_path: string | null;
  dsh_attachment_id: string | null;
  created_at: string;
  expires_at: string;
}

interface OrganizationRow {
  revision: number;
  sort_mode: OrganizationRecord["sortMode"];
  custom_order_json: string;
  folders_json: string;
  assignments_json: string;
}

type SqlRow = Record<string, SQLOutputValue>;

/** `SELECT`/`RETURNING` 的行与上面的 Row 接口一一对应；只在这一处做类型收窄。 */
const rowOf = <T>(row: SqlRow | undefined): T | undefined => row as unknown as T | undefined;

/** 深冻结：对象读取必须返回不可变快照，避免调用方改到存储内部状态。 */
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

const parseStringArray = (json: string, label: string): readonly string[] => {
  const parsed = parseJson(json, label);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw corrupt(`${label} must be a string array`);
  }
  return deepFreeze(parsed as string[]);
};

const parseFolders = (json: string, label: string): readonly ConversationFolder[] => {
  const parsed = parseJson(json, label);
  if (!Array.isArray(parsed)) throw corrupt(`${label} must be an array`);
  const folders = parsed.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw corrupt(`${label}[${index}] must be an object`);
    }
    const record = value as Record<string, unknown>;
    if (typeof record.folderId !== "string" || typeof record.name !== "string") {
      throw corrupt(`${label}[${index}] must contain folderId and name`);
    }
    return Object.freeze({ folderId: record.folderId, name: record.name });
  });
  return Object.freeze(folders);
};

const parseAssignments = (json: string, label: string): Record<string, string> => {
  const parsed = parseJson(json, label);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw corrupt(`${label} must be a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") throw corrupt(`${label}.${key} must be a string`);
  }
  // 使用展开而不是逐键赋值，避免 `__proto__` 之类的键触发原型 setter。
  return deepFreeze({ ...(record as Record<string, string>) });
};

/** 组织快照 CAS 失败：上层据此返回契约码 `GRANT_STALE`/冲突类错误。 */
export class OrganizationConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`ORGANIZATION_REVISION_CONFLICT: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "OrganizationConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/**
 * 单账号 SQLite 存储（`node:sqlite` 的同步 DatabaseSync）。
 *
 * 约定：
 * - 每个写操作（包括单条 UPDATE）都在 `BEGIN IMMEDIATE` 事务中执行，失败回滚；
 * - 读取返回深冻结的新对象，与内部行数据完全解耦；
 * - 时间字段按调用方给的 ISO 字符串原样保存，过期查询用字符串比较。
 */
export class SqliteAccountStore implements AccountStore {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #transactionDepth = 0;
  #closed = false;

  constructor(databasePath: string) {
    this.#db = new DatabaseSync(databasePath, {
      // 外键检查交给本层的写事务（见迁移注释），避免宿主升级/删号时被级联约束卡住。
      enableForeignKeyConstraints: false,
    });
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
    // 多进程（宿主的 CLI 与 Web 进程）共用同一账号库时等待锁而不是立刻失败。
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // WAL 允许读写并发；同步级别 NORMAL 在 WAL 下足够安全。
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
        // PRAGMA 不能参数化；version 来自本文件的常量，不存在注入面。
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
    // 目录 0700 由调用方保证（见 contract.ts）；数据库及其 WAL/SHM/journal 收紧到 0600。
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
    if (this.#closed) throw new Error("STORE_CLOSED: the account store has been closed");
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

  /**
   * 事务包装器：顶层使用 `BEGIN IMMEDIATE`，已处于事务中时只增加嵌套计数。
   * 任何异常都会回滚，保证多步写入不会留下半成品。
   */
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
  // 设备与配对
  // ---------------------------------------------------------------------------

  insertDevice(input: InsertDeviceInput): DeviceRecord {
    return this.#transaction(() => {
      this.#stmt(
        `INSERT INTO devices
           (device_id, installation_id, public_key, display_name, pairing_id, pairing_generation, paired_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        input.deviceId,
        input.installationId,
        input.publicKey,
        input.displayName,
        input.pairingId,
        input.pairingGeneration,
        input.pairedAt,
      );
      return this.#requireDevice(input.deviceId);
    });
  }

  getDevice(deviceId: string): DeviceRecord | undefined {
    return this.#readDevice(deviceId);
  }

  listDevices(): readonly DeviceRecord[] {
    const rows = this.#stmt(
      "SELECT * FROM devices ORDER BY paired_at ASC, device_id ASC",
    ).all() as SqlRow[];
    return Object.freeze(rows.map((row) => this.#deviceFromRow(rowOf<DeviceRow>(row)!)));
  }

  revokeDevice(deviceId: string, revokedAt: string): void {
    this.#transaction(() => {
      // 只记录第一次撤销时间，重复调用保持幂等。
      this.#stmt("UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").run(
        revokedAt,
        deviceId,
      );
    });
  }

  bumpPairingGeneration(deviceId: string, next: number): DeviceRecord | undefined {
    return this.#transaction(() => {
      const result = this.#stmt("UPDATE devices SET pairing_generation = ? WHERE device_id = ?").run(
        next,
        deviceId,
      );
      if (this.#changes(result) === 0) return undefined;
      return this.#readDevice(deviceId);
    });
  }

  #readDevice(deviceId: string): DeviceRecord | undefined {
    const row = rowOf<DeviceRow>(this.#stmt("SELECT * FROM devices WHERE device_id = ?").get(deviceId));
    return row === undefined ? undefined : this.#deviceFromRow(row);
  }

  #requireDevice(deviceId: string): DeviceRecord {
    const record = this.#readDevice(deviceId);
    if (record === undefined) throw corrupt(`devices row ${deviceId} missing after write`);
    return record;
  }

  #deviceFromRow(row: DeviceRow): DeviceRecord {
    return Object.freeze({
      deviceId: row.device_id,
      installationId: row.installation_id,
      publicKey: row.public_key,
      displayName: row.display_name,
      pairingId: row.pairing_id,
      pairingGeneration: row.pairing_generation,
      pairedAt: row.paired_at,
      revokedAt: row.revoked_at,
    });
  }

  // ---------------------------------------------------------------------------
  // refresh 凭据
  // ---------------------------------------------------------------------------

  insertRefreshCredential(input: InsertRefreshCredentialInput): RefreshCredentialRecord {
    return this.#transaction(() => {
      this.#stmt(
        `INSERT INTO refresh_credentials (credential_hash, device_id, installation_id, created_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL)`,
      ).run(input.credentialHash, input.deviceId, input.installationId, input.createdAt);
      const record = this.findRefreshCredential(input.credentialHash);
      if (record === undefined) throw corrupt("refresh_credentials row missing after write");
      return record;
    });
  }

  findRefreshCredential(hash: string): RefreshCredentialRecord | undefined {
    const row = rowOf<RefreshCredentialRow>(
      this.#stmt("SELECT * FROM refresh_credentials WHERE credential_hash = ?").get(hash),
    );
    return row === undefined ? undefined : this.#refreshCredentialFromRow(row);
  }

  revokeRefreshCredential(hash: string, revokedAt: string): void {
    this.#transaction(() => {
      this.#stmt(
        "UPDATE refresh_credentials SET revoked_at = ? WHERE credential_hash = ? AND revoked_at IS NULL",
      ).run(revokedAt, hash);
    });
  }

  revokeRefreshCredentialsForDevice(deviceId: string, revokedAt: string): number {
    return this.#transaction(() => {
      const result = this.#stmt(
        "UPDATE refresh_credentials SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
      ).run(revokedAt, deviceId);
      return this.#changes(result);
    });
  }

  #refreshCredentialFromRow(row: RefreshCredentialRow): RefreshCredentialRecord {
    return Object.freeze({
      credentialHash: row.credential_hash,
      deviceId: row.device_id,
      installationId: row.installation_id,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    });
  }

  // ---------------------------------------------------------------------------
  // access session
  // ---------------------------------------------------------------------------

  insertAccessSession(input: InsertAccessSessionInput): AccessSessionRecord {
    return this.#transaction(() => {
      this.#stmt(
        `INSERT INTO access_sessions (session_id, token_hash, device_id, created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      ).run(input.sessionId, input.tokenHash, input.deviceId, input.createdAt, input.expiresAt);
      const record = this.findAccessSession(input.sessionId);
      if (record === undefined) throw corrupt("access_sessions row missing after write");
      return record;
    });
  }

  findAccessSessionByTokenHash(tokenHash: string): AccessSessionRecord | undefined {
    const row = rowOf<AccessSessionRow>(
      this.#stmt("SELECT * FROM access_sessions WHERE token_hash = ?").get(tokenHash),
    );
    return row === undefined ? undefined : this.#accessSessionFromRow(row);
  }

  findAccessSession(sessionId: string): AccessSessionRecord | undefined {
    const row = rowOf<AccessSessionRow>(
      this.#stmt("SELECT * FROM access_sessions WHERE session_id = ?").get(sessionId),
    );
    return row === undefined ? undefined : this.#accessSessionFromRow(row);
  }

  revokeAccessSession(sessionId: string, revokedAt: string): void {
    this.#transaction(() => {
      this.#stmt(
        "UPDATE access_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
      ).run(revokedAt, sessionId);
    });
  }

  revokeAccessSessionsForDevice(deviceId: string, revokedAt: string): number {
    return this.#transaction(() => {
      const result = this.#stmt(
        "UPDATE access_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
      ).run(revokedAt, deviceId);
      return this.#changes(result);
    });
  }

  pruneExpiredAccessSessions(nowIso: string): number {
    return this.#transaction(() => {
      // ISO 8601 UTC 毫秒字符串等长同格式，字典序即时间序。
      const result = this.#stmt("DELETE FROM access_sessions WHERE expires_at <= ?").run(nowIso);
      return this.#changes(result);
    });
  }

  #accessSessionFromRow(row: AccessSessionRow): AccessSessionRecord {
    return Object.freeze({
      sessionId: row.session_id,
      tokenHash: row.token_hash,
      deviceId: row.device_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    });
  }

  // ---------------------------------------------------------------------------
  // nonce 防重放
  // ---------------------------------------------------------------------------

  hasNonce(nonce: string): boolean {
    return this.#stmt("SELECT 1 AS present FROM nonces WHERE nonce = ?").get(nonce) !== undefined;
  }

  recordNonce(nonce: string, expiresAt: string): void {
    this.#transaction(() => {
      // 重复记录同一 nonce 时更新过期时间；真正的重放判定由 hasNonce 负责。
      this.#stmt(
        `INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)
         ON CONFLICT(nonce) DO UPDATE SET expires_at = excluded.expires_at`,
      ).run(nonce, expiresAt);
    });
  }

  pruneNonces(nowIso: string): number {
    return this.#transaction(() => {
      const result = this.#stmt("DELETE FROM nonces WHERE expires_at <= ?").run(nowIso);
      return this.#changes(result);
    });
  }

  // ---------------------------------------------------------------------------
  // 幂等账本
  // ---------------------------------------------------------------------------

  findIdempotency(scope: string, requestId: string): IdempotencyRecord | undefined {
    const row = rowOf<IdempotencyRow>(
      this.#stmt("SELECT * FROM idempotency WHERE scope = ? AND request_id = ?").get(scope, requestId),
    );
    if (row === undefined) return undefined;
    return Object.freeze({
      scope: row.scope,
      requestId: row.request_id,
      fingerprint: row.fingerprint,
      responseJson: row.response_json,
      createdAt: row.created_at,
    });
  }

  saveIdempotency(record: IdempotencyRecord): void {
    this.#transaction(() => {
      // 冲突时保留首次写入：上层用 findIdempotency 比对 fingerprint 后决定返回原响应
      // 还是抛 IDEMPOTENCY_CONFLICT；本层不会用后来的记录覆盖原终态。
      this.#stmt(
        `INSERT INTO idempotency (scope, request_id, fingerprint, response_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope, request_id) DO NOTHING`,
      ).run(record.scope, record.requestId, record.fingerprint, record.responseJson, record.createdAt);
    });
  }

  // ---------------------------------------------------------------------------
  // 事件流
  // ---------------------------------------------------------------------------

  appendEvent(input: AppendEventInput): EventRecord {
    return this.#transaction(() => {
      const payloadJson = stringifyJson(input.payload, "events.payload_json");
      const row = rowOf<{ seq: number }>(
        this.#stmt(
          `INSERT INTO events (event_id, type, payload_json, occurred_at, correlation_id)
           VALUES (?, ?, ?, ?, ?)
           RETURNING seq`,
        ).get(input.eventId, input.type, payloadJson, input.occurredAt, input.correlationId),
      );
      if (row === undefined) throw corrupt("events row missing after write");
      return Object.freeze({
        seq: row.seq,
        eventId: input.eventId,
        type: input.type,
        payload: parseJsonObject(payloadJson, "events.payload_json"),
        occurredAt: input.occurredAt,
        correlationId: input.correlationId,
      });
    });
  }

  listEventsAfter(seq: number, limit: number): readonly EventRecord[] {
    if (!Number.isFinite(limit) || limit <= 0) return Object.freeze([]);
    const rows = this.#stmt(
      "SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?",
    ).all(seq, Math.floor(limit)) as SqlRow[];
    return Object.freeze(rows.map((row) => this.#eventFromRow(rowOf<EventRow>(row)!)));
  }

  findEventByEventId(eventId: string): EventRecord | undefined {
    const row = rowOf<EventRow>(this.#stmt("SELECT * FROM events WHERE event_id = ?").get(eventId));
    return row === undefined ? undefined : this.#eventFromRow(row);
  }

  latestEventSeq(): number {
    const row = rowOf<{ seq: number }>(
      this.#stmt("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get(),
    );
    return row?.seq ?? 0;
  }

  oldestEventSeq(): number | null {
    const row = rowOf<{ seq: number | null }>(this.#stmt("SELECT MIN(seq) AS seq FROM events").get());
    return row?.seq ?? null;
  }

  pruneEvents(olderThanIso: string): number {
    return this.#transaction(() => {
      const result = this.#stmt("DELETE FROM events WHERE occurred_at < ?").run(olderThanIso);
      return this.#changes(result);
    });
  }

  #eventFromRow(row: EventRow): EventRecord {
    return Object.freeze({
      seq: row.seq,
      eventId: row.event_id,
      type: row.type,
      payload: parseJsonObject(row.payload_json, "events.payload_json"),
      occurredAt: row.occurred_at,
      correlationId: row.correlation_id,
    });
  }

  // ---------------------------------------------------------------------------
  // 会话
  // ---------------------------------------------------------------------------

  insertConversation(input: InsertConversationInput): ConversationRecord {
    return this.#transaction(() => {
      const snapshotRevision = this.#bumpSnapshotRevision();
      this.#stmt(
        `INSERT INTO conversations
           (conversation_id, client_conversation_id, dsh_session_id, title, archived, deleted,
            created_at, updated_at, last_message_at, snapshot_revision)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, NULL, ?)`,
      ).run(
        input.conversationId,
        input.clientConversationId,
        input.dshSessionId,
        input.title,
        input.createdAt,
        input.updatedAt,
        snapshotRevision,
      );
      return this.#requireConversation(input.conversationId);
    });
  }

  getConversation(conversationId: string): ConversationRecord | undefined {
    return this.#readConversation(conversationId);
  }

  findConversationByClientId(clientConversationId: string): ConversationRecord | undefined {
    const row = rowOf<ConversationRow>(
      this.#stmt("SELECT * FROM conversations WHERE client_conversation_id = ?").get(clientConversationId),
    );
    return row === undefined ? undefined : this.#conversationFromRow(row);
  }

  listConversations(): readonly ConversationRecord[] {
    // 契约 §7：分页按更新时间倒序、会话 ID 升序稳定排序；这里提前给出一致顺序。
    const rows = this.#stmt(
      "SELECT * FROM conversations ORDER BY updated_at DESC, conversation_id ASC",
    ).all() as SqlRow[];
    return Object.freeze(rows.map((row) => this.#conversationFromRow(rowOf<ConversationRow>(row)!)));
  }

  updateConversation(
    conversationId: string,
    patch: ConversationPatch,
  ): ConversationRecord | undefined {
    return this.#transaction(() => {
      const existing = this.#readConversation(conversationId);
      if (existing === undefined) return undefined;
      const assignments: string[] = [];
      const params: SQLInputValue[] = [];
      if (patch.dshSessionId !== undefined) {
        assignments.push("dsh_session_id = ?");
        params.push(patch.dshSessionId);
      }
      if (patch.title !== undefined) {
        assignments.push("title = ?");
        params.push(patch.title);
      }
      if (patch.archived !== undefined) {
        assignments.push("archived = ?");
        params.push(patch.archived ? 1 : 0);
      }
      if (patch.deleted !== undefined) {
        assignments.push("deleted = ?");
        params.push(patch.deleted ? 1 : 0);
      }
      if (patch.updatedAt !== undefined) {
        assignments.push("updated_at = ?");
        params.push(patch.updatedAt);
      }
      if (patch.lastMessageAt !== undefined) {
        assignments.push("last_message_at = ?");
        params.push(patch.lastMessageAt);
      }
      if (assignments.length === 0) return existing;
      // 记录发生变化：快照 revision 必须前进，旧游标据此失效。
      assignments.push("snapshot_revision = ?");
      params.push(this.#bumpSnapshotRevision());
      params.push(conversationId);
      this.#stmt(
        `UPDATE conversations SET ${assignments.join(", ")} WHERE conversation_id = ?`,
      ).run(...params);
      return this.#readConversation(conversationId);
    });
  }

  /**
   * 每次调用都把会话列表快照 revision 递增 1。
   *
   * 会话创建/修改也会走同一个计数器（各自推进一格），因此任何一次 list 拿到的
   * revision 都严格大于此前所有记录版本，旧分页游标可以可靠地判定为过期。
   */
  nextSnapshotRevision(): number {
    return this.#transaction(() => this.#bumpSnapshotRevision());
  }

  #bumpSnapshotRevision(): number {
    // 必须在事务内调用；RETURNING 让「读-改-写」保持原子。
    const row = rowOf<{ value: number }>(
      this.#stmt("UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value").get(
        SNAPSHOT_COUNTER,
      ),
    );
    if (row === undefined) throw corrupt(`counters.${SNAPSHOT_COUNTER} missing`);
    return row.value;
  }

  #readConversation(conversationId: string): ConversationRecord | undefined {
    const row = rowOf<ConversationRow>(
      this.#stmt("SELECT * FROM conversations WHERE conversation_id = ?").get(conversationId),
    );
    return row === undefined ? undefined : this.#conversationFromRow(row);
  }

  #requireConversation(conversationId: string): ConversationRecord {
    const record = this.#readConversation(conversationId);
    if (record === undefined) throw corrupt(`conversations row ${conversationId} missing after write`);
    return record;
  }

  #conversationFromRow(row: ConversationRow): ConversationRecord {
    return Object.freeze({
      conversationId: row.conversation_id,
      clientConversationId: row.client_conversation_id,
      dshSessionId: row.dsh_session_id,
      title: row.title,
      archived: row.archived !== 0,
      deleted: row.deleted !== 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at,
      snapshotRevision: row.snapshot_revision,
    });
  }

  // ---------------------------------------------------------------------------
  // 消息
  // ---------------------------------------------------------------------------

  insertMessage(input: InsertMessageInput): MessageRecord {
    return this.#transaction(() => {
      this.#stmt(
        `INSERT INTO messages
           (message_id, conversation_id, client_message_id, sender, text, parts_json, status,
            revision, error_code, generation_id, dsh_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.messageId,
        input.conversationId,
        input.clientMessageId,
        input.sender,
        input.text,
        stringifyJson(input.parts, "messages.parts_json"),
        input.status,
        input.revision,
        input.errorCode,
        input.generationId,
        input.dshSeq,
        input.createdAt,
        input.createdAt,
      );
      return this.#requireMessage(input.messageId);
    });
  }

  getMessage(messageId: string): MessageRecord | undefined {
    return this.#readMessage(messageId);
  }

  findMessageByClientId(
    conversationId: string,
    clientMessageId: string,
  ): MessageRecord | undefined {
    const row = rowOf<MessageRow>(
      this.#stmt("SELECT * FROM messages WHERE conversation_id = ? AND client_message_id = ?").get(
        conversationId,
        clientMessageId,
      ),
    );
    return row === undefined ? undefined : this.#messageFromRow(row);
  }

  listMessages(conversationId: string): readonly MessageRecord[] {
    const rows = this.#stmt(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, message_id ASC",
    ).all(conversationId) as SqlRow[];
    return Object.freeze(rows.map((row) => this.#messageFromRow(rowOf<MessageRow>(row)!)));
  }

  updateMessage(messageId: string, patch: MessagePatch): MessageRecord | undefined {
    return this.#transaction(() => {
      const existing = this.#readMessage(messageId);
      if (existing === undefined) return undefined;
      const assignments: string[] = [];
      const params: SQLInputValue[] = [];
      if (patch.status !== undefined) {
        assignments.push("status = ?");
        params.push(patch.status);
      }
      if (patch.revision !== undefined) {
        assignments.push("revision = ?");
        params.push(patch.revision);
      }
      if (patch.errorCode !== undefined) {
        assignments.push("error_code = ?");
        params.push(patch.errorCode);
      }
      if (patch.text !== undefined) {
        assignments.push("text = ?");
        params.push(patch.text);
      }
      if (patch.parts !== undefined) {
        assignments.push("parts_json = ?");
        params.push(stringifyJson(patch.parts, "messages.parts_json"));
      }
      if (patch.dshSeq !== undefined) {
        assignments.push("dsh_seq = ?");
        params.push(patch.dshSeq);
      }
      if (patch.generationId !== undefined) {
        assignments.push("generation_id = ?");
        params.push(patch.generationId);
      }
      if (patch.updatedAt !== undefined) {
        assignments.push("updated_at = ?");
        params.push(patch.updatedAt);
      }
      if (assignments.length === 0) return existing;
      params.push(messageId);
      this.#stmt(`UPDATE messages SET ${assignments.join(", ")} WHERE message_id = ?`).run(...params);
      return this.#readMessage(messageId);
    });
  }

  findMessageByDshSeq(conversationId: string, dshSeq: number): MessageRecord | undefined {
    const row = rowOf<MessageRow>(
      this.#stmt(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND dsh_seq = ?
         ORDER BY created_at ASC, message_id ASC
         LIMIT 1`,
      ).get(conversationId, dshSeq),
    );
    return row === undefined ? undefined : this.#messageFromRow(row);
  }

  #readMessage(messageId: string): MessageRecord | undefined {
    const row = rowOf<MessageRow>(this.#stmt("SELECT * FROM messages WHERE message_id = ?").get(messageId));
    return row === undefined ? undefined : this.#messageFromRow(row);
  }

  #requireMessage(messageId: string): MessageRecord {
    const record = this.#readMessage(messageId);
    if (record === undefined) throw corrupt(`messages row ${messageId} missing after write`);
    return record;
  }

  #messageFromRow(row: MessageRow): MessageRecord {
    return deepFreeze({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      clientMessageId: row.client_message_id,
      sender: row.sender,
      text: row.text,
      parts: this.#parseParts(row.parts_json),
      status: row.status,
      revision: row.revision,
      errorCode: row.error_code,
      generationId: row.generation_id,
      dshSeq: row.dsh_seq,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  #parseParts(json: string): readonly MessagePart[] {
    const parsed = parseJson(json, "messages.parts_json");
    if (!Array.isArray(parsed)) throw corrupt("messages.parts_json must be an array");
    return deepFreeze(parsed as MessagePart[]);
  }

  // ---------------------------------------------------------------------------
  // 生成
  // ---------------------------------------------------------------------------

  insertGeneration(input: InsertGenerationInput): GenerationRecord {
    return this.#transaction(() => {
      this.#stmt(
        `INSERT INTO generations (generation_id, conversation_id, message_id, state, created_at, ended_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      ).run(
        input.generationId,
        input.conversationId,
        input.messageId,
        input.state,
        input.createdAt,
      );
      return this.#requireGeneration(input.generationId);
    });
  }

  getGeneration(generationId: string): GenerationRecord | undefined {
    const row = rowOf<GenerationRow>(
      this.#stmt("SELECT * FROM generations WHERE generation_id = ?").get(generationId),
    );
    return row === undefined ? undefined : this.#generationFromRow(row);
  }

  findGenerationByMessage(messageId: string): GenerationRecord | undefined {
    // 同一条消息可能因重试产生多条 generation；返回最近创建的一条。
    const row = rowOf<GenerationRow>(
      this.#stmt(
        `SELECT * FROM generations WHERE message_id = ?
         ORDER BY created_at DESC, generation_id ASC LIMIT 1`,
      ).get(messageId),
    );
    return row === undefined ? undefined : this.#generationFromRow(row);
  }

  listActiveGenerations(conversationId: string): readonly GenerationRecord[] {
    const rows = this.#stmt(
      `SELECT * FROM generations
       WHERE conversation_id = ? AND state IN ('queued', 'running')
       ORDER BY created_at ASC, generation_id ASC`,
    ).all(conversationId) as SqlRow[];
    return Object.freeze(rows.map((row) => this.#generationFromRow(rowOf<GenerationRow>(row)!)));
  }

  updateGeneration(generationId: string, patch: GenerationPatch): GenerationRecord | undefined {
    return this.#transaction(() => {
      const existing = this.getGeneration(generationId);
      if (existing === undefined) return undefined;
      const assignments: string[] = [];
      const params: SQLInputValue[] = [];
      if (patch.state !== undefined) {
        assignments.push("state = ?");
        params.push(patch.state);
      }
      if (patch.endedAt !== undefined) {
        assignments.push("ended_at = ?");
        params.push(patch.endedAt);
      }
      if (assignments.length === 0) return existing;
      params.push(generationId);
      this.#stmt(`UPDATE generations SET ${assignments.join(", ")} WHERE generation_id = ?`).run(
        ...params,
      );
      return this.getGeneration(generationId);
    });
  }

  #requireGeneration(generationId: string): GenerationRecord {
    const record = this.getGeneration(generationId);
    if (record === undefined) throw corrupt(`generations row ${generationId} missing after write`);
    return record;
  }

  #generationFromRow(row: GenerationRow): GenerationRecord {
    return Object.freeze({
      generationId: row.generation_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      state: row.state,
      createdAt: row.created_at,
      endedAt: row.ended_at,
    });
  }

  // ---------------------------------------------------------------------------
  // 附件
  // ---------------------------------------------------------------------------

  insertAttachment(input: InsertAttachmentInput): AttachmentRecord {
    return this.#transaction(() => {
      this.#stmt(
        `INSERT INTO attachments
           (attachment_id, client_attachment_id, filename, media_type, size_bytes, sha256, status,
            storage_path, dsh_attachment_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        input.attachmentId,
        input.clientAttachmentId,
        input.filename,
        input.mediaType,
        input.sizeBytes,
        input.sha256,
        input.status,
        input.storagePath,
        input.createdAt,
        input.expiresAt,
      );
      return this.#requireAttachment(input.attachmentId);
    });
  }

  getAttachment(attachmentId: string): AttachmentRecord | undefined {
    const row = rowOf<AttachmentRow>(
      this.#stmt("SELECT * FROM attachments WHERE attachment_id = ?").get(attachmentId),
    );
    return row === undefined ? undefined : this.#attachmentFromRow(row);
  }

  findAttachmentByClientId(clientAttachmentId: string): AttachmentRecord | undefined {
    const row = rowOf<AttachmentRow>(
      this.#stmt("SELECT * FROM attachments WHERE client_attachment_id = ?").get(clientAttachmentId),
    );
    return row === undefined ? undefined : this.#attachmentFromRow(row);
  }

  updateAttachment(attachmentId: string, patch: AttachmentPatch): AttachmentRecord | undefined {
    return this.#transaction(() => {
      const existing = this.getAttachment(attachmentId);
      if (existing === undefined) return undefined;
      const assignments: string[] = [];
      const params: SQLInputValue[] = [];
      if (patch.status !== undefined) {
        assignments.push("status = ?");
        params.push(patch.status);
      }
      if (patch.storagePath !== undefined) {
        assignments.push("storage_path = ?");
        params.push(patch.storagePath);
      }
      if (patch.dshAttachmentId !== undefined) {
        assignments.push("dsh_attachment_id = ?");
        params.push(patch.dshAttachmentId);
      }
      if (patch.sizeBytes !== undefined) {
        assignments.push("size_bytes = ?");
        params.push(patch.sizeBytes);
      }
      if (patch.sha256 !== undefined) {
        assignments.push("sha256 = ?");
        params.push(patch.sha256);
      }
      if (assignments.length === 0) return existing;
      params.push(attachmentId);
      this.#stmt(`UPDATE attachments SET ${assignments.join(", ")} WHERE attachment_id = ?`).run(
        ...params,
      );
      return this.getAttachment(attachmentId);
    });
  }

  /**
   * 超过 TTL 且尚未投影为 `expired` 的附件，供清扫器删除暂存字节并推进状态。
   * 已标记 expired 的记录不再重复返回；比较完全按 ISO 字符串进行。
   */
  listExpiredAttachments(nowIso: string): readonly AttachmentRecord[] {
    const rows = this.#stmt(
      `SELECT * FROM attachments
       WHERE expires_at <= ? AND status <> 'expired'
       ORDER BY expires_at ASC, attachment_id ASC`,
    ).all(nowIso) as SqlRow[];
    return Object.freeze(rows.map((row) => this.#attachmentFromRow(rowOf<AttachmentRow>(row)!)));
  }

  #requireAttachment(attachmentId: string): AttachmentRecord {
    const record = this.getAttachment(attachmentId);
    if (record === undefined) throw corrupt(`attachments row ${attachmentId} missing after write`);
    return record;
  }

  #attachmentFromRow(row: AttachmentRow): AttachmentRecord {
    return Object.freeze({
      attachmentId: row.attachment_id,
      clientAttachmentId: row.client_attachment_id,
      filename: row.filename,
      mediaType: row.media_type,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      status: row.status,
      storagePath: row.storage_path,
      dshAttachmentId: row.dsh_attachment_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    });
  }

  // ---------------------------------------------------------------------------
  // 会话组织
  // ---------------------------------------------------------------------------

  getOrganization(): OrganizationRecord {
    const existing = this.#readOrganization();
    if (existing !== undefined) return existing;
    // 迁移已写入默认行；这里兜底处理被外部工具误删的极端情况。
    return this.#transaction(() => {
      this.#stmt(
        `INSERT INTO organization (id, revision, sort_mode, custom_order_json, folders_json, assignments_json)
         VALUES (1, 0, 'updated-desc', '[]', '[]', '{}')
         ON CONFLICT(id) DO NOTHING`,
      ).run();
      const created = this.#readOrganization();
      if (created === undefined) throw corrupt("organization row missing after write");
      return created;
    });
  }

  replaceOrganization(
    expectedRevision: number,
    next: Omit<OrganizationRecord, "revision">,
  ): OrganizationRecord {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("expectedRevision must be a non-negative safe integer");
    }
    return this.#transaction(() => {
      const current = this.#readOrganization();
      const actualRevision = current?.revision ?? 0;
      if (actualRevision !== expectedRevision) {
        throw new OrganizationConflictError(expectedRevision, actualRevision);
      }
      const revision = expectedRevision + 1;
      // 先复制再序列化，避免调用方在写后继续修改传入数组影响返回值。
      const customOrder = Object.freeze([...next.customOrder]);
      const folders = Object.freeze(
        next.folders.map((folder) => Object.freeze({ folderId: folder.folderId, name: folder.name })),
      );
      const assignments = deepFreeze({ ...next.assignments });
      this.#stmt(
        `INSERT INTO organization
           (id, revision, sort_mode, custom_order_json, folders_json, assignments_json)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           revision = excluded.revision,
           sort_mode = excluded.sort_mode,
           custom_order_json = excluded.custom_order_json,
           folders_json = excluded.folders_json,
           assignments_json = excluded.assignments_json`,
      ).run(
        revision,
        next.sortMode,
        stringifyJson(customOrder, "organization.custom_order_json"),
        stringifyJson(folders, "organization.folders_json"),
        stringifyJson(assignments, "organization.assignments_json"),
      );
      return Object.freeze({
        revision,
        sortMode: next.sortMode,
        customOrder,
        folders,
        assignments,
      });
    });
  }

  #readOrganization(): OrganizationRecord | undefined {
    const row = rowOf<OrganizationRow>(
      this.#stmt(
        "SELECT revision, sort_mode, custom_order_json, folders_json, assignments_json FROM organization WHERE id = 1",
      ).get(),
    );
    if (row === undefined) return undefined;
    return Object.freeze({
      revision: row.revision,
      sortMode: row.sort_mode,
      customOrder: parseStringArray(row.custom_order_json, "organization.custom_order_json"),
      folders: parseFolders(row.folders_json, "organization.folders_json"),
      assignments: parseAssignments(row.assignments_json, "organization.assignments_json"),
    });
  }
}

/**
 * 打开（或首次创建）一个账号的数据库。
 *
 * 目录存在性与 0700 权限由调用方保证（见 contract.ts）；本函数负责建表/迁移、
 * WAL 配置与文件 0600 收紧。数据库路径覆盖 `:memory:` 便于测试。
 */
export const openAccountStore: OpenAccountStore = (databasePath) =>
  new SqliteAccountStore(databasePath);
