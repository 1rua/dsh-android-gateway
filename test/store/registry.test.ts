import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WIRE_ID_PATTERN } from "../../src/shared/ids.js";
import type { AccountRegistration } from "../../src/shared/types.js";
import { ACCOUNT_REGISTRY_FILE, createAccountRegistry } from "../../src/store/index.js";
import { createTempDir, removeTempDir } from "./helpers.js";

let tempDir: string;
let rootDir: string;
let filePath: string;

beforeEach(() => {
  tempDir = createTempDir("dsh-gateway-registry-");
  rootDir = join(tempDir, "gateway");
  filePath = join(rootDir, ACCOUNT_REGISTRY_FILE);
});

afterEach(() => {
  removeTempDir(tempDir);
});

const registration = (
  accountId: string,
  username: string,
  overrides: Partial<AccountRegistration> = {},
): AccountRegistration => ({
  accountId,
  username,
  passwordSalt: "00112233445566778899aabbccddeeff",
  passwordHash: "aa".repeat(64),
  createdAt: "2026-10-20T00:00:00.000Z",
  ...overrides,
});

/** 已存在的临时文件（原子写失败残留）：用于断言清理。 */
const tempFiles = (): string[] => readdirSync(rootDir).filter((name) => name.endsWith(".tmp"));

describe("账号注册表", () => {
  it("首次访问创建目录与 accounts.json，deploymentId 生成并稳定", () => {
    const registry = createAccountRegistry(rootDir);
    const deploymentId = registry.deploymentId();

    expect(deploymentId).toMatch(WIRE_ID_PATTERN);
    expect(registry.deploymentId()).toBe(deploymentId);
    expect(existsSync(filePath)).toBe(true);
    expect(tempFiles()).toEqual([]);

    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      version: number;
      deploymentId: string;
      accounts: unknown[];
    };
    expect(parsed).toEqual({ version: 1, deploymentId, accounts: [] });

    if (process.platform !== "win32") {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(statSync(rootDir).mode & 0o777).toBe(0o700);
    }
  });

  it("已存在的宽松目录会被收紧到 0700", () => {
    mkdirSync(rootDir, { recursive: true, mode: 0o755 });
    chmodSync(rootDir, 0o755);
    createAccountRegistry(rootDir).deploymentId();
    if (process.platform !== "win32") {
      expect(statSync(rootDir).mode & 0o777).toBe(0o700);
    }
  });

  it("新增、查询、列出与移除账号", async () => {
    const registry = createAccountRegistry(rootDir);
    await registry.add(registration("acct_1", "alice"));
    await registry.add(registration("acct_2", "bob"));

    const listed = registry.list();
    expect(listed.map((account) => account.accountId)).toEqual(["acct_1", "acct_2"]);
    expect(registry.findById("acct_1")?.username).toBe("alice");
    expect(registry.findByUsername("bob")?.accountId).toBe("acct_2");
    expect(registry.findById("missing")).toBeUndefined();
    expect(registry.findByUsername("missing")).toBeUndefined();
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);

    await registry.remove("acct_1");
    expect(registry.list().map((account) => account.accountId)).toEqual(["acct_2"]);
    // 移除不存在的账号是幂等的。
    await expect(registry.remove("acct_missing")).resolves.toBeUndefined();
    expect(tempFiles()).toEqual([]);
  });

  it("重启后 deploymentId 与账号保持不变", async () => {
    const first = createAccountRegistry(rootDir);
    const deploymentId = first.deploymentId();
    await first.add(registration("acct_1", "alice"));

    const second = createAccountRegistry(rootDir);
    expect(second.deploymentId()).toBe(deploymentId);
    expect(second.list()).toHaveLength(1);
    expect(second.findByUsername("alice")?.accountId).toBe("acct_1");

    await second.add(registration("acct_2", "bob"));
    expect(createAccountRegistry(rootDir).list()).toHaveLength(2);
  });

  it("拒绝重复 accountId / username，失败时不写坏文件", async () => {
    const registry = createAccountRegistry(rootDir);
    await registry.add(registration("acct_1", "alice"));
    const before = readFileSync(filePath, "utf8");

    await expect(registry.add(registration("acct_1", "alice2"))).rejects.toThrow(/ACCOUNT_ALREADY_EXISTS/);
    await expect(registry.add(registration("acct_2", "alice"))).rejects.toThrow(/USERNAME_ALREADY_EXISTS/);
    expect(registry.list()).toHaveLength(1);
    expect(readFileSync(filePath, "utf8")).toBe(before);
    expect(tempFiles()).toEqual([]);
  });

  it("并发新增被串行化，全部落盘", async () => {
    const registry = createAccountRegistry(rootDir);
    await Promise.all([
      registry.add(registration("acct_1", "alice")),
      registry.add(registration("acct_2", "bob")),
      registry.add(registration("acct_3", "carol")),
    ]);
    expect(registry.list().map((account) => account.username)).toEqual(["alice", "bob", "carol"]);
    expect(createAccountRegistry(rootDir).list()).toHaveLength(3);

    const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as { accounts: unknown[] };
    expect(onDisk.accounts).toHaveLength(3);
  });

  it("损坏或版本不支持的注册表必须报错，不静默重建", () => {
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(filePath, "{ 这不是 JSON", { mode: 0o600 });
    expect(() => createAccountRegistry(rootDir).deploymentId()).toThrow(/ACCOUNT_REGISTRY_CORRUPT/);
    expect(readFileSync(filePath, "utf8")).toBe("{ 这不是 JSON");

    writeFileSync(
      filePath,
      JSON.stringify({ version: 2, deploymentId: "dep_x", accounts: [] }),
      { mode: 0o600 },
    );
    expect(() => createAccountRegistry(rootDir).deploymentId()).toThrow(/ACCOUNT_REGISTRY_CORRUPT/);

    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        deploymentId: "dep_x",
        accounts: [registration("acct_1", "alice"), registration("acct_1", "bob")],
      }),
      { mode: 0o600 },
    );
    expect(() => createAccountRegistry(rootDir).deploymentId()).toThrow(/duplicate accountId/);
  });

  it("注册表内容使用原子写：写入后无残留临时文件且格式可解析", async () => {
    const registry = createAccountRegistry(rootDir);
    const deploymentId = registry.deploymentId();
    await registry.add(registration("acct_1", "alice"));
    await registry.remove("acct_1");
    await registry.add(registration("acct_2", "bob"));

    expect(tempFiles()).toEqual([]);
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      version: number;
      deploymentId: string;
      accounts: AccountRegistration[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.deploymentId).toBe(deploymentId);
    expect(parsed.accounts.map((account) => account.accountId)).toEqual(["acct_2"]);
  });
});
