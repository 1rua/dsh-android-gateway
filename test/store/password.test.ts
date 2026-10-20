import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../../src/store/index.js";

describe("口令摘要", () => {
  it("生成随机盐与 scrypt 摘要，并能正确校验", () => {
    const digest = hashPassword("correct horse battery staple");
    expect(digest.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(digest.hash).toMatch(/^[0-9a-f]{128}$/);
    expect(Object.isFrozen(digest)).toBe(true);

    expect(verifyPassword("correct horse battery staple", digest.salt, digest.hash)).toBe(true);
    expect(verifyPassword("wrong password", digest.salt, digest.hash)).toBe(false);
    expect(verifyPassword("", digest.salt, digest.hash)).toBe(false);
  });

  it("每次生成不同盐，同一口令得到不同摘要", () => {
    const first = hashPassword("same-password");
    const second = hashPassword("same-password");
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
    expect(verifyPassword("same-password", first.salt, first.hash)).toBe(true);
    expect(verifyPassword("same-password", second.salt, second.hash)).toBe(true);
  });

  it("支持 Unicode 与长口令", () => {
    const password = "密码🔐-with-äöü-" + "x".repeat(200);
    const digest = hashPassword(password);
    expect(verifyPassword(password, digest.salt, digest.hash)).toBe(true);
    expect(verifyPassword(password + "!", digest.salt, digest.hash)).toBe(false);
  });

  it("摘要被篡改或格式非法时返回 false 而不是抛错", () => {
    const digest = hashPassword("secret");
    expect(verifyPassword("secret", digest.salt, digest.hash.slice(0, -2))).toBe(false);
    expect(verifyPassword("secret", "not-hex", digest.hash)).toBe(false);
    expect(verifyPassword("secret", digest.salt, "zz".repeat(64))).toBe(false);
    expect(verifyPassword("secret", "", digest.hash)).toBe(false);
    expect(verifyPassword("secret", digest.salt, "")).toBe(false);
  });

  it("同步接口可被 await 调用，兼容异步调用方", async () => {
    const digest = await hashPassword("await-compatible");
    const ok = await verifyPassword("await-compatible", digest.salt, digest.hash);
    expect(ok).toBe(true);
  });
});
