import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * 口令摘要结果：`salt` 与 `hash` 都是小写十六进制字符串。
 * 注册表只保存这两项，明文口令绝不落盘、绝不进日志。
 */
export interface PasswordDigest {
  readonly salt: string;
  readonly hash: string;
}

/** 随机盐长度（字节）。 */
export const PASSWORD_SALT_BYTES = 16;
/** scrypt 派生密钥长度（字节）。 */
export const PASSWORD_HASH_BYTES = 64;

/**
 * scrypt 参数：N=16384 / r=8 / p=1，即 Node 默认的安全基线。
 * `maxmem` 显式给足，避免不同 Node 版本默认值变化导致校验失败。
 */
const SCRYPT_OPTIONS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/** 严格解码定长十六进制；长度或字符不合法时返回 undefined。 */
const decodeHex = (value: unknown, expectedBytes: number): Buffer | undefined => {
  if (typeof value !== "string" || value.length !== expectedBytes * 2) return undefined;
  if (!HEX_PATTERN.test(value)) return undefined;
  return Buffer.from(value, "hex");
};

/**
 * 用随机盐派生口令摘要。
 *
 * 这里刻意使用同步 API：账号登录/注册只发生在低频的管理路径上，同步实现让调用方
 * 可以 `await`（对非 Promise 值 await 是合法的），也可以直接同步使用，避免集成时
 * 因同步/异步签名不一致出错。
 */
export const hashPassword = (password: string): PasswordDigest => {
  if (typeof password !== "string") {
    throw new TypeError("hashPassword(password) expects a string");
  }
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const hash = scryptSync(password, salt, PASSWORD_HASH_BYTES, SCRYPT_OPTIONS);
  return Object.freeze({ salt: salt.toString("hex"), hash: hash.toString("hex") });
};

/**
 * 常量时间校验口令。
 *
 * 任何存储侧异常（盐非十六进制、摘要长度不对、未知算法参数）都折叠为 `false`，
 * 不向调用方泄露更多信息；`timingSafeEqual` 只在两侧长度一致时比较。
 */
export const verifyPassword = (password: string, salt: string, hash: string): boolean => {
  if (typeof password !== "string") return false;
  const saltBytes = decodeHex(salt, PASSWORD_SALT_BYTES);
  const expected = decodeHex(hash, PASSWORD_HASH_BYTES);
  if (saltBytes === undefined || expected === undefined) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, saltBytes, expected.length, SCRYPT_OPTIONS);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
};
