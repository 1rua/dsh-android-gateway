import { join } from "node:path";

/**
 * 插件配置。DSH 的 Config schema 是可选的；本插件不声明 Config 导出，
 * 因此这里对每个字段做防御性解析，缺省值写死在一处，便于诊断。
 */
export interface AndroidGatewayConfig {
  /** 新会话的工作目录；缺省使用 DSH 默认目录。 */
  readonly workspace?: string;
  /** 网关数据根目录；缺省 `$DSH_HOME/dsh-android-gateway`。 */
  readonly dataDir?: string;
  /** 首次启动自动创建账号时使用的用户名。 */
  readonly defaultUsername?: string;
  /** 预置账号（明文密码只在插件启动时用于生成摘要，不落盘明文）。 */
  readonly accounts?: readonly {
    readonly accountId?: string;
    readonly username: string;
    readonly password: string;
  }[];
  /** 附件暂存 TTL，默认 3600 秒；协商响应会如实下发。 */
  readonly attachmentTtlSeconds?: number;
  /** 事件保留时间，默认 86400 秒。 */
  readonly eventRetentionSeconds?: number;
  /** 允许的时钟偏差，默认 120 秒。 */
  readonly maxClockSkewSeconds?: number;
  /** 附件暂存字节上限，默认 256 MiB。 */
  readonly maxAttachmentBytes?: number;
  /** 显式部署的 TLS SPKI 摘要；明文部署保持 undefined（协商返回 null）。 */
  readonly tlsSpkiSha256?: string | null;
  /** SSE 心跳间隔，默认 15000 毫秒。 */
  readonly heartbeatMs?: number;
}

export interface ResolvedConfig {
  readonly workspace: string | undefined;
  readonly dataDir: string;
  readonly defaultUsername: string;
  readonly accounts: readonly { accountId?: string; username: string; password: string }[];
  readonly attachmentTtlSeconds: number;
  readonly eventRetentionSeconds: number;
  readonly maxClockSkewSeconds: number;
  readonly maxAttachmentBytes: number;
  readonly tlsSpkiSha256: string | null;
  readonly heartbeatMs: number;
}

const positiveInt = (value: unknown, fallback: number, minimum = 1): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : fallback;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const resolveDataDir = (value: unknown): string => {
  const explicit = nonEmptyString(value);
  if (explicit !== undefined) return explicit;
  const home = nonEmptyString(process.env.DSH_HOME);
  if (home !== undefined) return join(home, "dsh-android-gateway");
  return join(process.cwd(), ".dsh-android-gateway");
};

export const resolveConfig = (raw: unknown): ResolvedConfig => {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const accounts: { accountId?: string; username: string; password: string }[] = [];
  if (Array.isArray(record.accounts)) {
    for (const entry of record.accounts) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const username = nonEmptyString(item.username);
      const password = typeof item.password === "string" ? item.password : undefined;
      if (username === undefined || password === undefined || password.length === 0) continue;
      const accountId = nonEmptyString(item.accountId);
      accounts.push({ ...(accountId === undefined ? {} : { accountId }), username, password });
    }
  }
  const tls = record.tlsSpkiSha256;
  const tlsSpkiSha256 =
    tls === null
      ? null
      : typeof tls === "string" && /^sha256:[0-9a-f]{64}$/.test(tls) && !/^sha256:0+$/.test(tls)
        ? tls
        : null;
  return {
    workspace: nonEmptyString(record.workspace),
    dataDir: resolveDataDir(record.dataDir),
    defaultUsername: nonEmptyString(record.defaultUsername) ?? "android",
    accounts,
    attachmentTtlSeconds: positiveInt(record.attachmentTtlSeconds, 3600),
    eventRetentionSeconds: positiveInt(record.eventRetentionSeconds, 86_400),
    maxClockSkewSeconds: positiveInt(record.maxClockSkewSeconds, 120, 0),
    maxAttachmentBytes: positiveInt(record.maxAttachmentBytes, 256 * 1024 * 1024),
    tlsSpkiSha256,
    heartbeatMs: positiveInt(record.heartbeatMs, 15_000, 1_000),
  };
};
