/**
 * 存储层统一出口。
 *
 * - `contract.ts`：接口与输入类型（契约，不可擅自删改）；
 * - `sqlite.ts`：每账号 SQLite 持久化（node:sqlite）；
 * - `registry.ts`：多账号注册表（accounts.json 原子写）；
 * - `password.ts`：scrypt 口令摘要与常量时间校验。
 */
export * from "./contract.js";
export { OrganizationConflictError, openAccountStore, SqliteAccountStore } from "./sqlite.js";
export { ACCOUNT_REGISTRY_FILE, createAccountRegistry } from "./registry.js";
export { hashPassword, verifyPassword } from "./password.js";
export type { PasswordDigest } from "./password.js";
