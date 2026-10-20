import { randomBytes } from "node:crypto";

/**
 * 契约 §2 的 wire ID：`^[A-Za-z0-9._~-]{1,128}$`。
 * 所有跨端不透明标识（requestId、conversationId、messageId…）都必须满足它。
 */
export const WIRE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

export const isWireId = (value: unknown): value is string =>
  typeof value === "string" && WIRE_ID_PATTERN.test(value);

export const assertWireId = (value: unknown, label: string): string => {
  if (!isWireId(value)) {
    throw new Error(`INVALID_WIRE_ID:${label}`);
  }
  return value;
};

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 生成 `<prefix><base36 时间戳><随机 base36>` 形式的短标识，满足 wire ID。 */
export const createWireId = (prefix: string, randomBytesCount = 10): string => {
  const time = Date.now().toString(36);
  const bytes = randomBytes(randomBytesCount);
  let random = "";
  for (const byte of bytes) random += ALPHABET[byte % ALPHABET.length];
  return `${prefix}${time}${random}`;
};

/** 不透明高熵令牌（access token / refresh credential / 主密钥），base64url 无填充。 */
export const createSecretToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/** 契约 §2：时间必须是最多/恰好三位毫秒的 RFC 3339 UTC。 */
export const UTC_MILLIS_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export const nowIso = (date: Date = new Date()): string => date.toISOString();

export const nowMillis = (): number => Date.now();

export const isoToMillis = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
