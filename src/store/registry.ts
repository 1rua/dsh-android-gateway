import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { createWireId, isWireId } from "../shared/ids.js";
import type { AccountRegistration, AccountRegistryApi } from "../shared/types.js";

/** 注册表文件名（契约 §5.1：先解析账号，再打开账号库）。 */
export const ACCOUNT_REGISTRY_FILE = "accounts.json";

const REGISTRY_VERSION = 1;

/**
 * 进程内的只读注册表快照。
 *
 * 注意：`shared/types.ts` 的 `AccountRegistryFile.accounts` 是可变的（它描述落盘 JSON），
 * 这里用只读视图保证内存状态不会被调用方改动；两者字段结构一一对应。
 */
interface RegistryState {
  readonly version: 1;
  readonly deploymentId: string;
  readonly accounts: readonly AccountRegistration[];
}

const corrupt = (detail: string): Error => new Error(`ACCOUNT_REGISTRY_CORRUPT:${detail}`);

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw corrupt(`${label} must be a non-empty string`);
  }
  return value;
};

const freezeRegistration = (registration: AccountRegistration): AccountRegistration =>
  Object.freeze({
    accountId: registration.accountId,
    username: registration.username,
    passwordSalt: registration.passwordSalt,
    passwordHash: registration.passwordHash,
    createdAt: registration.createdAt,
  });

/** 校验磁盘上的单条账号记录，绝不静默丢弃坏数据。 */
const parseRegistration = (value: unknown, index: number): AccountRegistration => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw corrupt(`accounts[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const accountId = requireString(record.accountId, `accounts[${index}].accountId`);
  if (!isWireId(accountId)) {
    throw corrupt(`accounts[${index}].accountId must be a wire id`);
  }
  return freezeRegistration({
    accountId,
    username: requireString(record.username, `accounts[${index}].username`),
    passwordSalt: requireString(record.passwordSalt, `accounts[${index}].passwordSalt`),
    passwordHash: requireString(record.passwordHash, `accounts[${index}].passwordHash`),
    createdAt: requireString(record.createdAt, `accounts[${index}].createdAt`),
  });
};

/** 解析整份注册表；版本、deploymentId 与重复账号都视为损坏。 */
const parseRegistryFile = (value: unknown): RegistryState => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw corrupt("root must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== REGISTRY_VERSION) {
    throw corrupt(`unsupported version ${String(record.version)}`);
  }
  const deploymentId = requireString(record.deploymentId, "deploymentId");
  if (!isWireId(deploymentId)) {
    throw corrupt("deploymentId must be a wire id");
  }
  if (!Array.isArray(record.accounts)) {
    throw corrupt("accounts must be an array");
  }
  const accounts = record.accounts.map((entry, index) => parseRegistration(entry, index));
  const accountIds = new Set<string>();
  const usernames = new Set<string>();
  for (const account of accounts) {
    if (accountIds.has(account.accountId)) {
      throw corrupt(`duplicate accountId ${account.accountId}`);
    }
    if (usernames.has(account.username)) {
      throw corrupt(`duplicate username ${account.username}`);
    }
    accountIds.add(account.accountId);
    usernames.add(account.username);
  }
  return Object.freeze({
    version: REGISTRY_VERSION,
    deploymentId,
    accounts: Object.freeze(accounts),
  });
};

const validateNewRegistration = (registration: AccountRegistration): void => {
  if (!isWireId(registration.accountId)) {
    throw new TypeError("registration.accountId must be a wire id");
  }
  if (typeof registration.username !== "string" || registration.username.length === 0) {
    throw new TypeError("registration.username must be a non-empty string");
  }
  for (const field of ["passwordSalt", "passwordHash", "createdAt"] as const) {
    if (typeof registration[field] !== "string" || registration[field].length === 0) {
      throw new TypeError(`registration.${field} must be a non-empty string`);
    }
  }
};

/**
 * 多账号注册表：`<rootDir>/accounts.json`。
 *
 * 进程内单实例串行化写入，落盘使用「同目录临时文件 + fsync + rename」的原子替换，
 * 目录 0700、文件 0600。崩溃时要么是旧文件、要么是新文件，不会出现半份 JSON。
 */
class JsonAccountRegistry implements AccountRegistryApi {
  readonly #rootDir: string;
  readonly #filePath: string;
  #state: RegistryState | undefined;
  /** 写入串行化：add/remove 并发时不会互相覆盖。 */
  #tail: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
    this.#filePath = join(rootDir, ACCOUNT_REGISTRY_FILE);
  }

  deploymentId(): string {
    return this.#load().deploymentId;
  }

  list(): readonly AccountRegistration[] {
    return Object.freeze([...this.#load().accounts]);
  }

  findById(accountId: string): AccountRegistration | undefined {
    return this.#load().accounts.find((account) => account.accountId === accountId);
  }

  findByUsername(username: string): AccountRegistration | undefined {
    return this.#load().accounts.find((account) => account.username === username);
  }

  async add(registration: AccountRegistration): Promise<void> {
    return this.#enqueue(async () => {
      validateNewRegistration(registration);
      const current = this.#load();
      if (current.accounts.some((account) => account.accountId === registration.accountId)) {
        throw new Error(`ACCOUNT_ALREADY_EXISTS:${registration.accountId}`);
      }
      if (current.accounts.some((account) => account.username === registration.username)) {
        throw new Error(`USERNAME_ALREADY_EXISTS:${registration.username}`);
      }
      const next: RegistryState = Object.freeze({
        version: REGISTRY_VERSION,
        deploymentId: current.deploymentId,
        accounts: Object.freeze([...current.accounts, freezeRegistration(registration)]),
      });
      await this.#persist(next);
      this.#state = next;
    });
  }

  async remove(accountId: string): Promise<void> {
    return this.#enqueue(async () => {
      const current = this.#load();
      const remaining = current.accounts.filter((account) => account.accountId !== accountId);
      if (remaining.length === current.accounts.length) return;
      const next: RegistryState = Object.freeze({
        version: REGISTRY_VERSION,
        deploymentId: current.deploymentId,
        accounts: Object.freeze(remaining),
      });
      await this.#persist(next);
      this.#state = next;
    });
  }

  /** 同步加载（必要时创建）注册表；deploymentId() 等同步方法依赖它。 */
  #load(): RegistryState {
    if (this.#state !== undefined) return this.#state;
    try {
      mkdirSync(this.#rootDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new Error(`ACCOUNT_REGISTRY_UNAVAILABLE:${this.#rootDir}`, { cause: error });
    }
    try {
      // 目录可能由更早的版本以宽松权限创建：注册表含口令摘要，统一收紧到 0700。
      chmodSync(this.#rootDir, 0o700);
    } catch {
      // 权限收紧尽力而为（例如非 POSIX 平台）；文件本身仍是 0600。
    }
    if (existsSync(this.#filePath)) {
      try {
        chmodSync(this.#filePath, 0o600);
      } catch {
        // 权限收紧在非 POSIX 平台可能不支持；读取本身不因此失败。
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(this.#filePath, "utf8"));
      } catch (error) {
        throw corrupt(`cannot parse ${this.#filePath}`);
      }
      this.#state = parseRegistryFile(parsed);
      return this.#state;
    }
    // 首次启动：生成并持久化 deploymentId，保证重启后设备信任链稳定。
    const initial: RegistryState = Object.freeze({
      version: REGISTRY_VERSION,
      deploymentId: createWireId("dep_"),
      accounts: Object.freeze([]),
    });
    this.#writeSync(initial);
    this.#state = initial;
    return initial;
  }

  /** 同步原子写（仅供首次创建使用；add/remove 走异步写）。 */
  #writeSync(state: RegistryState): void {
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const tempPath = this.#tempPath();
    try {
      const fd = openSync(tempPath, "wx", 0o600);
      try {
        writeFileSync(fd, payload, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tempPath, this.#filePath);
      this.#chmodFileSync();
    } catch (error) {
      // 只清理本次原子写失败后遗留的自有临时文件，不触碰任何业务文件。
      try {
        unlinkSync(tempPath);
      } catch {
        // 临时文件可能根本未创建，忽略。
      }
      throw error;
    }
    this.#fsyncDirSync();
  }

  /** 异步原子写：写临时文件 → fsync → rename → 收紧权限。 */
  async #persist(state: RegistryState): Promise<void> {
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const tempPath = this.#tempPath();
    try {
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, this.#filePath);
      // rename 已保证原子替换；chmod 只是二次收紧密，失败不影响已提交数据。
      await chmod(this.#filePath, 0o600).catch(() => undefined);
    } catch (error) {
      // 同上：只回收本次写入的自有临时文件。
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await this.#fsyncDir();
  }

  #tempPath(): string {
    return `${this.#filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  }

  #chmodFileSync(): void {
    try {
      chmodSync(this.#filePath, 0o600);
    } catch {
      // 非 POSIX 平台忽略；文件创建时已用 0600。
    }
  }

  #fsyncDirSync(): void {
    let fd: number | undefined;
    try {
      fd = openSync(this.#rootDir, "r");
      fsyncSync(fd);
    } catch {
      // 部分平台不允许对目录 fsync；rename 已保证原子性。
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // 忽略关闭失败。
        }
      }
    }
  }

  async #fsyncDir(): Promise<void> {
    try {
      const handle = await open(this.#rootDir, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // 与同步版本一致：目录 fsync 属于尽力而为的持久化增强。
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * 打开（或首次创建）账号注册表。目录不存在时以 0700 创建；
 * 文件不存在时生成 deploymentId 并原子落盘。
 */
export const createAccountRegistry = (rootDir: string): AccountRegistryApi =>
  new JsonAccountRegistry(rootDir);
