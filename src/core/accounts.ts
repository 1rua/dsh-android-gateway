import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

import { createWireId } from "../shared/ids.js";
import type { AccountRegistration } from "../shared/types.js";
import type { AccountStore } from "../store/contract.js";
import { createAccountRegistry } from "../store/registry.js";
import { hashPassword, verifyPassword } from "../store/password.js";
import { openAccountStore } from "../store/sqlite.js";
import type { AccountRegistryApi } from "../shared/types.js";

export interface PairingState {
  readonly grantRevision: number;
  readonly grantDigest: string | null;
  readonly capabilityPublicationVersion: number;
}

export interface ConfiguredAccount {
  readonly accountId?: string;
  readonly username: string;
  readonly password: string;
}

export interface AccountManagerOptions {
  readonly rootDir: string;
  readonly defaultUsername?: string;
  readonly configuredAccounts?: readonly ConfiguredAccount[];
  readonly logger?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

const DEFAULT_USERNAME = "android";

/**
 * 多账号边界。
 *
 * 契约 §5.1 要求「先解析账号，再打开账号库」，所以账号注册表（用户名/密码摘要）
 * 与每账号数据库分开：注册表是一份 0600 JSON，各账号数据在独立 SQLite 与目录中。
 * 首次启动没有账号时自动生成一个随机密码账号，并把一次性凭据写入 0600 的
 * `setup-account.json`，供用户在手机端登录后删除。
 */
export class AccountManager {
  readonly #options: AccountManagerOptions;
  #registry: AccountRegistryApi | undefined;
  readonly #stores = new Map<string, AccountStore>();
  readonly #masterKeys = new Map<string, Buffer>();
  #initialized = false;

  constructor(options: AccountManagerOptions) {
    this.#options = options;
  }

  get rootDir(): string {
    return this.#options.rootDir;
  }

  get registry(): AccountRegistryApi {
    if (this.#registry === undefined) throw new Error("AccountManager is not initialized");
    return this.#registry;
  }

  accountDir(accountId: string): string {
    return join(this.rootDir, "accounts", accountId);
  }

  setupFilePath(): string {
    return join(this.rootDir, "setup-account.json");
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#mkdirPrivate(this.rootDir);
    this.#registry = createAccountRegistry(this.rootDir);
    const configured = this.#options.configuredAccounts ?? [];
    const existing = this.registry.list();
    for (const account of configured) {
      const found = this.registry.findByUsername(account.username);
      if (found !== undefined) continue;
      const accountId = account.accountId ?? createWireId("acct_");
      const { salt, hash } = await hashPassword(account.password);
      await this.registry.add({
        accountId,
        username: account.username,
        passwordSalt: salt,
        passwordHash: hash,
        createdAt: new Date().toISOString(),
      });
    }
    if (this.registry.list().length === 0) {
      await this.#provisionDefaultAccount();
    }
    for (const registration of this.registry.list()) {
      this.#ensureAccountDirs(registration.accountId);
    }
    this.#initialized = true;
  }

  async #provisionDefaultAccount(): Promise<void> {
    const username = this.#options.defaultUsername ?? DEFAULT_USERNAME;
    const password = randomBytes(24).toString("base64url");
    const accountId = createWireId("acct_");
    const { salt, hash } = await hashPassword(password);
    const registration: AccountRegistration = {
      accountId,
      username,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
    };
    await this.registry.add(registration);
    this.#ensureAccountDirs(accountId);
    const setup = {
      username,
      password,
      accountId,
      deploymentId: this.registry.deploymentId(),
      gatewayBasePath: "/open-android-intelligence/v2",
      createdAt: registration.createdAt,
      note: "此文件包含一次性登录凭据（0600）。连接成功后请删除。",
    };
    const path = this.setupFilePath();
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(setup, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    this.#options.logger?.warn(
      `[dsh-android-gateway] 已创建默认 Gateway 账号，一次性凭据写入 ${path}（0600）。请尽快在手机端登录并删除该文件。`,
    );
  }

  #ensureAccountDirs(accountId: string): void {
    const dir = this.accountDir(accountId);
    this.#mkdirPrivate(dir);
    this.#mkdirPrivate(join(dir, "attachments"));
    this.#mkdirPrivate(join(dir, "trash"));
  }

  #mkdirPrivate(path: string): void {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    try {
      chmodSync(path, 0o700);
    } catch {
      // 非 POSIX 平台或只读挂载交给上层报错；这里不掩盖后续真实 I/O 失败。
    }
  }

  deploymentId(): string {
    return this.registry.deploymentId();
  }

  findAccount(accountId: string): AccountRegistration | undefined {
    return this.registry.findById(accountId);
  }

  findAccountByUsername(username: string): AccountRegistration | undefined {
    return this.registry.findByUsername(username);
  }

  async verifyAccountPassword(accountId: string, password: string): Promise<boolean> {
    const account = this.registry.findById(accountId);
    if (account === undefined) return false;
    return verifyPassword(password, account.passwordSalt, account.passwordHash);
  }

  openStore(accountId: string): AccountStore | undefined {
    const cached = this.#stores.get(accountId);
    if (cached !== undefined) return cached;
    const registration = this.registry.findById(accountId);
    if (registration === undefined) return undefined;
    const dir = this.accountDir(accountId);
    this.#mkdirPrivate(dir);
    const store = openAccountStore(join(dir, "gateway.db"));
    this.#stores.set(accountId, store);
    return store;
  }

  /** 读取账号级配对授权状态（`pairing.json`，0600）。缺失时返回缺省值。 */
  readPairingState(accountId: string): PairingState {
    const path = join(this.accountDir(accountId), "pairing.json");
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PairingState>;
      return {
        grantRevision:
          typeof parsed.grantRevision === "number" && parsed.grantRevision >= 0
            ? parsed.grantRevision
            : 1,
        grantDigest: typeof parsed.grantDigest === "string" ? parsed.grantDigest : null,
        capabilityPublicationVersion:
          typeof parsed.capabilityPublicationVersion === "number"
            ? parsed.capabilityPublicationVersion
            : 2,
      };
    } catch {
      return { grantRevision: 1, grantDigest: null, capabilityPublicationVersion: 2 };
    }
  }

  /** 原子写入配对授权状态。 */
  writePairingState(accountId: string, state: PairingState): void {
    const dir = this.accountDir(accountId);
    this.#mkdirPrivate(dir);
    const path = join(dir, "pairing.json");
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  }

  /** 每账号 32 字节 AEAD 主密钥，0600；不进入数据库与日志。 */
  masterKey(accountId: string): Buffer {
    const cached = this.#masterKeys.get(accountId);
    if (cached !== undefined) return cached;
    const dir = this.accountDir(accountId);
    this.#mkdirPrivate(dir);
    const path = join(dir, "master.key");
    let key: Buffer;
    if (existsSync(path)) {
      key = readFileSync(path);
      if (key.length !== 32) {
        throw new Error(`MASTER_KEY_INVALID:${path} must contain exactly 32 bytes`);
      }
    } else {
      key = randomBytes(32);
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, key);
      } finally {
        closeSync(fd);
      }
      chmodSync(path, 0o600);
    }
    this.#masterKeys.set(accountId, key);
    return key;
  }

  close(): void {
    for (const store of this.#stores.values()) {
      try {
        store.close();
      } catch {
        // 关闭失败不阻断其余账号关闭。
      }
    }
    this.#stores.clear();
    this.#masterKeys.clear();
  }
}

/** 生成摘要用于幂等指纹（不含正文明文）。 */
export const fingerprintOf = (parts: readonly string[]): string =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex");
