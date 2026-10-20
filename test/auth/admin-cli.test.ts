import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountManager } from "../../src/core/accounts.js";
import { NegotiationManager } from "../../src/core/negotiation.js";
import { PairingInviteService } from "../../src/core/pairing-invites.js";
import { CORE_SCHEMA_HASH } from "../../src/protocol/index.js";
import type { JsonObject } from "../../src/shared/types.js";
import { removeTempDir } from "../store/helpers.js";
import { canonicalJson, createDeviceKey, signBytes } from "./helpers.js";

const ADMIN = fileURLToPath(new URL("../../tools/admin.mjs", import.meta.url));
const ACCOUNT_ID = "acct_cli";
const DEPLOYMENT_ID = "dep_cli";
const DOMAIN = "OPEN_ANDROID_INTELLIGENCE_PAIRING_V1\n";

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("管理 CLI（tools/admin.mjs）", () => {
  let tempRoot: string;
  let dataRoot: string;
  let env: NodeJS.ProcessEnv;

  const runCli = (...args: readonly string[]): string =>
    execFileSync(process.execPath, [ADMIN, ...args], { encoding: "utf8", env });

  const runCliFailure = (...args: readonly string[]) =>
    spawnSync(process.execPath, [ADMIN, ...args], { encoding: "utf8", env });

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "dsh-admin-test-"));
    dataRoot = join(tempRoot, "dsh-android-gateway");
    mkdirSync(join(dataRoot, "accounts", ACCOUNT_ID), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dataRoot, "accounts.json"),
      `${JSON.stringify(
        {
          version: 1,
          deploymentId: DEPLOYMENT_ID,
          accounts: [
            {
              accountId: ACCOUNT_ID,
              username: "alice",
              passwordSalt: "00".repeat(16),
              passwordHash: "00".repeat(64),
              createdAt: "2026-10-20T12:00:00.000Z",
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    env = { ...process.env, DSH_HOME: tempRoot };
    delete env.DSH_WEB_URL;
    delete env.DSH_ANDROID_TLS_SPKI_SHA256;
  });

  afterEach(() => {
    removeTempDir(tempRoot);
  });

  it("--help 输出全部用法", () => {
    const stdout = runCli("--help");
    expect(stdout).toContain("invite create");
    expect(stdout).toContain("invite list");
    expect(stdout).toContain("invite revoke");
    expect(stdout).toContain("status");
    expect(stdout).toContain("--ttl");
  });

  it("status 显示数据目录、部署 ID 与账号邀请计数", () => {
    const stdout = runCli("status");
    expect(stdout).toContain(dataRoot);
    expect(stdout).toContain(DEPLOYMENT_ID);
    expect(stdout).toContain("alice");
    expect(stdout).toContain("活跃邀请 0/128");
  });

  it("invite create 生成短码、深链与 0600 邀请文件", () => {
    const stdout = runCli("invite", "create", "--account", "alice", "--url", "http://127.0.0.1:43535", "--ttl", "60");
    const code = /短码: ([A-F0-9]{16})/.exec(stdout)?.[1];
    const invitationId = /邀请 ID: (\S+)/.exec(stdout)?.[1];
    const link = /链接: (oai:\/\/\S+)/.exec(stdout)?.[1];
    expect(code).toBeDefined();
    expect(invitationId).toMatch(/^invite_/);
    expect(link).toBeDefined();

    const uri = new URL(link as string);
    expect(uri.protocol).toBe("oai:");
    expect(uri.host).toBe("pair");
    expect(uri.searchParams.get("account")).toBe(ACCOUNT_ID);
    expect(uri.searchParams.get("code")).toBe(code);
    expect(uri.searchParams.get("identityFingerprint")).toMatch(/^sha256:[0-9a-f]{64}$/);

    const path = join(dataRoot, "accounts", ACCOUNT_ID, "invites.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      invites: Array<Record<string, unknown>>;
    };
    expect(stored.version).toBe(1);
    expect(stored.invites).toHaveLength(1);
    expect(stored.invites[0]?.invitationId).toBe(invitationId);
    expect(stored.invites[0]?.codeHash).toBe(sha256Hex(code as string));
    expect(stored.invites[0]?.usedAt).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('"code"');
  });

  it("CLI 创建的邀请可被 Gateway 服务直接挑战与兑换（格式互通）", async () => {
    const stdout = runCli("invite", "create", "--account", ACCOUNT_ID, "--ttl", "300");
    const code = /短码: ([A-F0-9]{16})/.exec(stdout)?.[1];
    expect(code).toBeDefined();

    const accounts = new AccountManager({ rootDir: dataRoot });
    await accounts.initialize();
    try {
      const negotiations = new NegotiationManager({
        deploymentId: () => accounts.deploymentId(),
        limits: {
          attachmentTtlSeconds: 3600,
          eventRetentionSeconds: 86_400,
          maxClockSkewSeconds: 120,
        },
        tlsSpkiSha256: null,
      });
      const negotiationId = "neg_cli";
      const installationId = "install_cli";
      const request = {
        negotiationId,
        protocol: { major: 2, minor: 1 },
        client: {
          installationId,
          appVersion: "2.1.0",
          platform: "android",
          platformApi: 35,
        },
        features: {
          auth: ["password", "account-invitation", "refresh", "device-key"],
          messages: ["chat-v1"],
          attachments: ["staged-sha256-v1"],
          events: ["sse-cursor-v1"],
          deviceRequests: ["risk-queue-v1"],
          conversationUi: [],
        },
        schemaHashes: { core: CORE_SCHEMA_HASH },
      } as unknown as JsonObject;
      negotiations.negotiate(request, "req_cli");

      const invites = new PairingInviteService({ accounts, negotiations, now: () => Date.now() });
      const key = createDeviceKey();
      const facts = invites.challenge(ACCOUNT_ID, {
        accountId: ACCOUNT_ID,
        negotiationId,
        code: code as string,
        installation: {
          installationId,
          displayName: "CLI Phone",
          devicePublicKey: key.devicePublicKey,
        },
      });
      const signature = signBytes(key.privateKey, `${DOMAIN}${canonicalJson(facts)}`);
      const exchanged = invites.exchange({
        accountId: ACCOUNT_ID,
        negotiationId,
        challengeId: facts.challengeId,
        signature,
      });
      expect(exchanged.accountId).toBe(ACCOUNT_ID);
      expect(exchanged.installation.devicePublicKey).toBe(key.devicePublicKey);
      // 兑换后 CLI list 应显示 used。
      expect(runCli("invite", "list", "--account", "alice")).toContain("状态=used");
    } finally {
      accounts.close();
    }
  });

  it("invite list 与 invite revoke 同步文件状态，撤销后不可再兑换", () => {
    const created = runCli("invite", "create", "--account", "alice", "--ttl", "300");
    const invitationId = /邀请 ID: (\S+)/.exec(created)?.[1] as string;
    const listed = runCli("invite", "list", "--account", "alice");
    expect(listed).toContain(invitationId);
    expect(listed).toContain("状态=active");

    const revoked = runCli(
      "invite",
      "revoke",
      "--account",
      "alice",
      "--id",
      invitationId,
    );
    expect(revoked).toContain("已撤销邀请");

    const after = runCli("invite", "list", "--account", "alice");
    expect(after).toContain("状态=used");
    const again = runCliFailure(
      "invite",
      "revoke",
      "--account",
      "alice",
      "--id",
      invitationId,
    );
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("已使用或已撤销");
  });

  it("非法参数与未知账号返回非零退出码", () => {
    const badTtl = runCliFailure("invite", "create", "--account", "alice", "--ttl", "10");
    expect(badTtl.status).not.toBe(0);
    expect(badTtl.stderr).toContain("--ttl");

    const unknown = runCliFailure("invite", "create", "--account", "nobody");
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("找不到账号");

    const unknownCommand = runCliFailure("invite", "explode");
    expect(unknownCommand.status).not.toBe(0);
  });
});
