#!/usr/bin/env node
/**
 * dsh-android-gateway 管理工具：账号邀请的创建、查看、撤销与状态诊断。
 *
 * 用法（无需构建，直接运行）：
 *   node tools/admin.mjs status
 *   node tools/admin.mjs invite create --account <accountId|username> [--url <gateway-url>] [--ttl 300]
 *   node tools/admin.mjs invite list --account <accountId|username>
 *   node tools/admin.mjs invite revoke --account <accountId|username> --id <invitationId>
 *
 * 数据目录与 Gateway 一致：`$DSH_HOME/dsh-android-gateway`（未设置 DSH_HOME 时
 * 回退到当前目录下的 `.dsh-android-gateway`）。邀请记录写入
 * `<root>/accounts/<accountId>/invites.json`，与 `src/core/pairing-invites.ts`
 * 保持同一格式（0600、版本 1、只存 sha256 短码摘要）。
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import canonicalize from "canonicalize";

/** 与 src/core/pairing-invites.ts 保持一致的约定常量。 */
const INVITES_VERSION = 1;
const MAX_ACTIVE_INVITES = 128;
const DEFAULT_INVITE_TTL_SECONDS = 300;
const MIN_INVITE_TTL_SECONDS = 30;
const MAX_INVITE_TTL_SECONDS = 900;
const CODE_PATTERN = /^[A-F0-9]{16}$/;
const WIRE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const TLS_SPKI_PATTERN = /^sha256:[0-9a-f]{64}$/;

const HELP = `dsh-android-gateway 管理工具

用法:
  node tools/admin.mjs status
  node tools/admin.mjs invite create --account <accountId|username> [--url <gateway-url>] [--ttl <30-900>]
  node tools/admin.mjs invite list --account <accountId|username>
  node tools/admin.mjs invite revoke --account <accountId|username> --id <invitationId>

命令:
  status             显示数据目录、部署 ID、账号与活跃邀请数量
  invite create      生成一次性邀请短码与 oai://pair?... 深链（默认 300 秒有效）
  invite list        列出账号的邀请（active / used / expired）
  invite revoke      立即撤销一条未使用的邀请

选项:
  --account <id>     账号 ID 或用户名（create/list/revoke 必填）
  --url <url>        写进深链的 Gateway 地址；缺省读 DSH_WEB_URL，
                     再缺省为 http://127.0.0.1:43535
  --ttl <seconds>    邀请有效期，30–900 秒，默认 300
  --id <id>          要撤销的 invitationId
  --help             显示本帮助

环境变量:
  DSH_HOME                           数据根目录（Gateway 使用同一变量）
  DSH_WEB_URL                        缺省 Gateway 地址
  DSH_ANDROID_TLS_SPKI_SHA256        可选 TLS SPKI 指纹，参与身份指纹计算

示例:
  DSH_HOME=/var/lib/dsh node tools/admin.mjs invite create --account android \\
    --url https://gateway.example.com --ttl 300
`;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

/** 与 Gateway 的 `resolveDataDir` 相同的根目录规则。 */
export const resolveRootDir = (env = process.env, cwd = process.cwd()) => {
  const home = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  return home.length > 0 ? join(home, "dsh-android-gateway") : join(cwd, ".dsh-android-gateway");
};

const createWireId = (prefix) => {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let random = "";
  for (const byte of randomBytes(10)) random += alphabet[byte % alphabet.length];
  return `${prefix}${Date.now().toString(36)}${random}`;
};

const isWireId = (value) => typeof value === "string" && WIRE_ID_PATTERN.test(value);

/** 读取账号注册表；不存在时返回 undefined，损坏时抛错而不是静默当作空。 */
export const readRegistry = (rootDir) => {
  const path = join(rootDir, "accounts.json");
  if (!existsSync(path)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(`账号注册表不是合法 JSON: ${path}（${error.message}）`);
  }
  if (parsed === null || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
    throw new CliError(`账号注册表格式不受支持: ${path}`);
  }
  return parsed;
};

const findAccount = (registry, query) => {
  const wanted = String(query);
  return registry.accounts.find(
    (account) => account.accountId === wanted || account.username === wanted,
  );
};

const invitesPath = (rootDir, accountId) => join(rootDir, "accounts", accountId, "invites.json");

/** 读取某账号的邀请记录；文件不存在视为空列表。 */
export const readInvites = (rootDir, accountId) => {
  const path = invitesPath(rootDir, accountId);
  if (!existsSync(path)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(`邀请文件不是合法 JSON: ${path}（${error.message}）`);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.version !== INVITES_VERSION ||
    !Array.isArray(parsed.invites)
  ) {
    throw new CliError(`邀请文件格式不受支持: ${path}`);
  }
  return parsed.invites;
};

const writeInvites = (rootDir, accountId, invites) => {
  const dir = join(rootDir, "accounts", accountId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // 非 POSIX 平台尽力而为。
  }
  const path = invitesPath(rootDir, accountId);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const payload = `${JSON.stringify({ version: INVITES_VERSION, invites }, null, 2)}\n`;
  try {
    writeFileSync(temp, payload, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // 临时文件可能尚未创建。
    }
    throw error;
  }
};

const isActive = (invite, now) => invite.usedAt === undefined && Date.parse(invite.expiresAt) > now;

const normalizeGatewayUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`--url 不是合法的绝对地址: ${value}`, 2);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError("--url 只支持 http:// 或 https://", 2);
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new CliError("--url 不能包含凭据、query 或 fragment", 2);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/u, "");
};

const buildPairUri = (input) =>
  `oai://pair?${new URLSearchParams({
    gateway: input.gatewayUrl,
    account: input.accountId,
    invitationId: input.invitationId,
    code: input.code,
    expiresAt: input.expiresAt,
    identityFingerprint: input.identityFingerprint,
  }).toString()}`;

/**
 * 纯函数：在内存中生成一条邀请记录（不写盘），便于测试与复用。
 * 短码 16 位大写十六进制；落盘字段与 Gateway 的 PairingInviteService 完全一致。
 */
export const buildInvite = (input) => {
  const now = input.now ?? Date.now();
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < MIN_INVITE_TTL_SECONDS || ttlSeconds > MAX_INVITE_TTL_SECONDS) {
    throw new CliError(`--ttl 必须是 ${MIN_INVITE_TTL_SECONDS}–${MAX_INVITE_TTL_SECONDS} 之间的整数`, 2);
  }
  const active = input.invites.filter((invite) => isActive(invite, now));
  if (active.length >= MAX_ACTIVE_INVITES) {
    throw new CliError(`同一账号最多 ${MAX_ACTIVE_INVITES} 条活跃邀请，请先撤销未使用的邀请`);
  }
  let code = "";
  let codeHash = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    code = randomBytes(8).toString("hex").toUpperCase();
    codeHash = sha256Hex(code);
    if (!input.invites.some((invite) => invite.codeHash === codeHash)) break;
  }
  if (!CODE_PATTERN.test(code)) throw new CliError("邀请码生成失败");
  const invitationId = createWireId("invite_");
  if (!isWireId(invitationId)) throw new CliError("邀请 ID 生成失败");
  const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
  return {
    record: {
      invitationId,
      codeHash,
      createdAt: new Date(now).toISOString(),
      expiresAt,
    },
    code,
    invitationId,
    expiresAt,
  };
};

const identityFingerprint = (deploymentId, tlsSpkiSha256) => {
  const canonical = canonicalize({ deploymentId, tlsSpkiSha256 });
  if (canonical === undefined) throw new CliError("无法规范化 gatewayIdentity");
  return `sha256:${sha256Hex(canonical)}`;
};

const parseArgv = (argv) => {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      flags.help = true;
      continue;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError(`选项 --${name} 缺少值`, 2);
      }
      flags[name] = value;
      index += 1;
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
};

const activeCount = (invites, now) => invites.filter((invite) => isActive(invite, now)).length;

const commandStatus = (rootDir) => {
  const registry = readRegistry(rootDir);
  console.log(`数据目录: ${rootDir}`);
  if (registry === undefined) {
    console.log("账号注册表: 不存在（请先启动 Gateway 完成初始化）");
    return;
  }
  console.log(`部署 ID: ${registry.deploymentId}`);
  console.log(`账号数: ${registry.accounts.length}`);
  const now = Date.now();
  for (const account of registry.accounts) {
    const invites = readInvites(rootDir, account.accountId);
    console.log(
      `- ${account.username} (${account.accountId}) 活跃邀请 ${activeCount(invites, now)}/${MAX_ACTIVE_INVITES}`,
    );
  }
};

const requireFlag = (flags, name) => {
  const value = flags[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliError(`缺少 --${name}`, 2);
  }
  return value.trim();
};

const resolveAccount = (registry, accountQuery) => {
  const account = findAccount(registry, accountQuery);
  if (account === undefined) {
    const known = registry.accounts
      .map((entry) => `${entry.username} (${entry.accountId})`)
      .join("、");
    throw new CliError(`找不到账号 ${accountQuery}；已知账号: ${known.length > 0 ? known : "无"}`);
  }
  return account;
};

const commandInviteCreate = (rootDir, flags) => {
  const registry = readRegistry(rootDir);
  if (registry === undefined) {
    throw new CliError(`账号注册表不存在: ${join(rootDir, "accounts.json")}（请先启动 Gateway）`);
  }
  const account = resolveAccount(registry, requireFlag(flags, "account"));
  const environmentUrl = (process.env.DSH_WEB_URL ?? "").trim();
  const gatewayUrl = normalizeGatewayUrl(
    flags.url ?? (environmentUrl.length > 0 ? environmentUrl : "http://127.0.0.1:43535"),
  );
  const ttlValue = flags.ttl === undefined ? DEFAULT_INVITE_TTL_SECONDS : Number(flags.ttl);
  const rawTlsSpki = flags["tls-spki"] ?? process.env.DSH_ANDROID_TLS_SPKI_SHA256;
  const tlsSpkiRaw =
    typeof rawTlsSpki === "string" && rawTlsSpki.trim().length > 0 ? rawTlsSpki.trim() : undefined;
  const tlsSpkiSha256 =
    typeof tlsSpkiRaw === "string" && TLS_SPKI_PATTERN.test(tlsSpkiRaw) && !/^sha256:0+$/.test(tlsSpkiRaw)
      ? tlsSpkiRaw
      : null;
  if (tlsSpkiRaw !== undefined && tlsSpkiSha256 === null) {
    throw new CliError("--tls-spki 必须是 sha256:<64 位小写 hex>（且不能全零）", 2);
  }

  const invites = readInvites(rootDir, account.accountId);
  const built = buildInvite({ invites, ttlSeconds: ttlValue });
  writeInvites(rootDir, account.accountId, [...invites, built.record]);
  const uri = buildPairUri({
    gatewayUrl,
    accountId: account.accountId,
    invitationId: built.invitationId,
    code: built.code,
    expiresAt: built.expiresAt,
    identityFingerprint: identityFingerprint(registry.deploymentId, tlsSpkiSha256),
  });
  console.log("邀请已创建");
  console.log(`账号: ${account.username} (${account.accountId})`);
  console.log(`邀请 ID: ${built.invitationId}`);
  console.log(`短码: ${built.code}`);
  console.log(`过期时间: ${built.expiresAt}`);
  console.log(`链接: ${uri}`);
  return 0;
};

const commandInviteList = (rootDir, flags) => {
  const registry = readRegistry(rootDir);
  if (registry === undefined) {
    throw new CliError(`账号注册表不存在: ${join(rootDir, "accounts.json")}（请先启动 Gateway）`);
  }
  const account = resolveAccount(registry, requireFlag(flags, "account"));
  const invites = readInvites(rootDir, account.accountId);
  const now = Date.now();
  console.log(
    `账号 ${account.username} (${account.accountId}) 邀请 ${invites.length} 条，活跃 ${activeCount(invites, now)}/${MAX_ACTIVE_INVITES}`,
  );
  if (invites.length === 0) {
    console.log("（无）");
    return 0;
  }
  for (const invite of invites) {
    const status =
      invite.usedAt !== undefined
        ? "used"
        : Date.parse(invite.expiresAt) <= now
          ? "expired"
          : "active";
    console.log(
      `- ${invite.invitationId} 状态=${status} 创建=${invite.createdAt} 过期=${invite.expiresAt}${
        invite.usedAt === undefined ? "" : ` 使用于=${invite.usedAt}`
      }`,
    );
  }
  return 0;
};

const commandInviteRevoke = (rootDir, flags) => {
  const registry = readRegistry(rootDir);
  if (registry === undefined) {
    throw new CliError(`账号注册表不存在: ${join(rootDir, "accounts.json")}（请先启动 Gateway）`);
  }
  const account = resolveAccount(registry, requireFlag(flags, "account"));
  const invitationId = requireFlag(flags, "id");
  const invites = readInvites(rootDir, account.accountId);
  const index = invites.findIndex((invite) => invite.invitationId === invitationId);
  if (index < 0) throw new CliError(`账号 ${account.username} 下不存在邀请 ${invitationId}`);
  const current = invites[index];
  if (current.usedAt !== undefined) {
    throw new CliError(`邀请 ${invitationId} 已使用或已撤销（${current.usedAt}）`);
  }
  const usedAt = new Date().toISOString();
  const next = invites.map((invite, position) =>
    position === index ? { ...invite, usedAt } : invite,
  );
  writeInvites(rootDir, account.accountId, next);
  console.log(`已撤销邀请 ${invitationId}（账号 ${account.username}，${usedAt}）`);
  return 0;
};

export const run = (argv, options = {}) => {
  const rootDir = options.rootDir ?? resolveRootDir();
  const { positionals, flags } = parseArgv(argv);
  if (flags.help === true || positionals.length === 0) {
    console.log(HELP);
    return 0;
  }
  const [group, action] = positionals;
  if (group === "status" && action === undefined) return commandStatus(rootDir) ?? 0;
  if (group === "invite" && action === "create") return commandInviteCreate(rootDir, flags);
  if (group === "invite" && action === "list") return commandInviteList(rootDir, flags);
  if (group === "invite" && action === "revoke") return commandInviteRevoke(rootDir, flags);
  throw new CliError(`未知命令: ${positionals.join(" ")}（使用 --help 查看用法）`, 2);
};

const main = () => {
  try {
    return run(process.argv.slice(2));
  } catch (error) {
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    console.error(`错误: ${error instanceof Error ? error.message : String(error)}`);
    return exitCode;
  }
};

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main();
}
