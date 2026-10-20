import { describe, expect, it } from "vitest";

import { GatewayError } from "../../src/shared/errors.js";
import type { GatewayErrorCode } from "../../src/shared/errors.js";
import {
  buildAuthHeaders,
  createTestBed,
  gatewayFetch,
} from "./helpers.js";

interface ErrorEnvelope {
  readonly requestId: string;
  readonly correlationId: string;
  readonly protocol: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly retryAfterSeconds: number | null;
    readonly details: Record<string, unknown>;
  };
}

interface SuccessEnvelope {
  readonly requestId: string;
  readonly correlationId: string;
  readonly protocol: string;
  readonly data: Record<string, unknown>;
}

const GENERATED_REQUEST_ID = /^req_[0-9a-z]+$/;

describe("预认证信封", () => {
  it("协商成功：requestId 是生成的 req_ wire id，core 的 correlationId 优先", async () => {
    const bed = await createTestBed();
    try {
      bed.core.result = {
        status: 200,
        data: { negotiation: { major: 2, minor: 1 } },
        correlationId: "neg_1",
      };
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/negotiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ negotiationId: "neg_1" }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as SuccessEnvelope;
      expect(body.requestId).toMatch(GENERATED_REQUEST_ID);
      expect(body.requestId).not.toBe("neg_1");
      expect(body.correlationId).toBe("neg_1");
      expect(body.protocol).toBe("2.1");
      expect(body.data).toEqual({ negotiation: { major: 2, minor: 1 } });
      expect(bed.core.calls).toHaveLength(1);
      expect(bed.core.calls[0]?.operation).toBe("negotiate");
    } finally {
      await bed.server.close();
    }
  });

  it("core 没有 correlationId 时 correlationId 复用同一 requestId", async () => {
    const bed = await createTestBed();
    try {
      bed.core.result = { status: 200, data: {} };
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/sessions/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as SuccessEnvelope;
      expect(body.requestId).toMatch(GENERATED_REQUEST_ID);
      expect(body.correlationId).toBe(body.requestId);
      expect(bed.core.calls[0]?.operation).toBe("refresh");
    } finally {
      await bed.server.close();
    }
  });

  it("预认证失败也返回五字段完整的错误信封（406 PROTOCOL_INCOMPATIBLE）", async () => {
    const bed = await createTestBed();
    try {
      bed.core.errors.set("negotiate", new GatewayError("PROTOCOL_INCOMPATIBLE"));
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/negotiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ negotiationId: "neg_2" }),
      });
      expect(response.status).toBe(406);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.requestId).toMatch(GENERATED_REQUEST_ID);
      expect(body.correlationId).toBe(body.requestId);
      expect(body.protocol).toBe("2.1");
      expect(body.error).toEqual({
        code: "PROTOCOL_INCOMPATIBLE",
        message: "PROTOCOL_INCOMPATIBLE",
        retryable: false,
        retryAfterSeconds: null,
        details: {},
      });
    } finally {
      await bed.server.close();
    }
  });

  it("密码登录失败返回 401 AUTHENTICATION_FAILED，不泄露账号存在性", async () => {
    const bed = await createTestBed();
    try {
      bed.core.errors.set("passwordLogin", new GatewayError("AUTHENTICATION_FAILED", "Invalid credentials"));
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/sessions/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "somebody", password: "wrong" }),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.code).toBe("AUTHENTICATION_FAILED");
      expect(body.error.retryable).toBe(false);
      expect(body.error.retryAfterSeconds).toBeNull();
      expect(body.error.details).toEqual({});
    } finally {
      await bed.server.close();
    }
  });
});

describe("错误码 → HTTP 状态映射", () => {
  const cases: ReadonlyArray<readonly [GatewayErrorCode, number]> = [
    ["AUTHENTICATION_REQUIRED", 401],
    ["AUTHENTICATION_FAILED", 401],
    ["SIGNATURE_INVALID", 401],
    ["SCHEMA_INVALID", 400],
    ["NON_CANONICAL_TARGET", 400],
    ["CLOCK_SKEWED", 400],
    ["REQUEST_REPLAYED", 409],
    ["PROTOCOL_INCOMPATIBLE", 406],
    ["CURSOR_CONFLICT", 409],
    ["CURSOR_EXPIRED", 410],
    ["CONVERSATION_BUSY", 409],
    ["CONVERSATION_ARCHIVED", 409],
    ["CONVERSATION_NOT_FOUND", 404],
    ["ORGANIZATION_CONFLICT", 409],
    ["CAPABILITY_UNAVAILABLE", 501],
    ["RATE_LIMITED", 429],
    ["INTERNAL_ERROR", 500],
    ["ATTACHMENT_EXPIRED", 400],
    ["IDEMPOTENCY_CONFLICT", 400],
  ];

  it("逐码映射，且失败信封字段始终完整", async () => {
    const bed = await createTestBed();
    try {
      for (const [code, status] of cases) {
        bed.verifier.verifyError = new GatewayError(code);
        const response = await gatewayFetch(bed, "/open-android-intelligence/v2/conversations", {
          headers: buildAuthHeaders(),
        });
        expect(response.status, code).toBe(status);
        const body = (await response.json()) as ErrorEnvelope;
        expect(body.error.code, code).toBe(code);
        expect(body.requestId, code).toBe("req_test_1");
        expect(body.correlationId, code).toBe("req_test_1");
        expect(body.protocol, code).toBe("2.1");
        expect(typeof body.error.message, code).toBe("string");
        expect(typeof body.error.retryable, code).toBe("boolean");
        expect(body.error).toHaveProperty("retryAfterSeconds");
        expect(body.error.details, code).toBeTypeOf("object");
      }
    } finally {
      await bed.server.close();
    }
  });

  it("GatewayError.httpStatus 优先于默认映射", async () => {
    const bed = await createTestBed();
    try {
      bed.verifier.verifyError = new GatewayError("SCHEMA_INVALID", "Unprocessable", { httpStatus: 422 });
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/conversations", {
        headers: buildAuthHeaders(),
      });
      expect(response.status).toBe(422);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("SCHEMA_INVALID");
    } finally {
      await bed.server.close();
    }
  });

  it("未知异常折叠为 500 INTERNAL_ERROR，不把堆栈写进 envelope", async () => {
    const bed = await createTestBed();
    try {
      bed.verifier.verifyError = new Error("secret stack detail");
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/conversations", {
        headers: buildAuthHeaders(),
      });
      expect(response.status).toBe(500);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(body)).not.toContain("secret stack detail");
    } finally {
      await bed.server.close();
    }
  });

  it("RATE_LIMITED 保留 retryAfterSeconds 与 details", async () => {
    const bed = await createTestBed();
    try {
      bed.verifier.verifyError = new GatewayError("RATE_LIMITED", "Slow down", {
        retryAfterSeconds: 7,
        details: { scope: "nonce-table" },
      });
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/conversations", {
        headers: buildAuthHeaders(),
      });
      expect(response.status).toBe(429);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.retryable).toBe(true);
      expect(body.error.retryAfterSeconds).toBe(7);
      expect(body.error.details).toEqual({ scope: "nonce-table" });
    } finally {
      await bed.server.close();
    }
  });
});

describe("路由边界", () => {
  it("mountPath 选项可以改变唯一挂载前缀", async () => {
    const bed = await createTestBed({ mountPath: "/custom/v2/" });
    try {
      const response = await gatewayFetch(bed, "/custom/v2/negotiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      const outside = await gatewayFetch(bed, "/open-android-intelligence/v2/negotiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(outside.status).toBe(404);
    } finally {
      await bed.server.close();
    }
  });

  it("固定前缀之外的路径返回 404 信封，不进入认证与业务", async () => {
    const bed = await createTestBed();
    try {
      for (const path of [
        "/",
        "/open-android-intelligence/v1/events",
        "/open-android-intelligence/v2x/negotiate",
        "/other",
      ]) {
        const response = await gatewayFetch(bed, path);
        expect(response.status, path).toBe(404);
        const body = (await response.json()) as ErrorEnvelope;
        expect(body.error.code, path).toBe("SCHEMA_INVALID");
        expect(body.protocol).toBe("2.1");
      }
      expect(bed.verifier.verifyCalls).toHaveLength(0);
      expect(bed.core.calls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("契约外 method 返回 404（不做 toUpperCase 别名）", async () => {
    const bed = await createTestBed();
    try {
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/negotiate", {
        method: "OPTIONS",
      });
      expect(response.status).toBe(404);
      expect(bed.core.calls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("前缀内未精确命中的路径交给 core.handle（携带认证）", async () => {
    const bed = await createTestBed();
    try {
      bed.core.result = { status: 200, data: { handled: true } };
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/unknown/route", {
        headers: buildAuthHeaders(),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as SuccessEnvelope;
      expect(body.data).toEqual({ handled: true });
      expect(bed.verifier.verifyCalls).toHaveLength(1);
      expect(bed.core.calls[0]?.operation).toBe("handle");
    } finally {
      await bed.server.close();
    }
  });
});
