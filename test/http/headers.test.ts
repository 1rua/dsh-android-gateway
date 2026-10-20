import { describe, expect, it } from "vitest";

import { GatewayError } from "../../src/shared/errors.js";
import {
  collectRawHeaders,
  validateContractHeaders,
} from "../../src/http/headers.js";
import {
  FAKE_REQUEST_ID,
  buildAuthHeaders,
  buildLogoutHeaders,
  buildMutationHeaders,
  createTestBed,
  gatewayFetch,
  rawHttpRequest,
} from "./helpers.js";

interface FailureEnvelope {
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly protocol?: string;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly retryable?: boolean;
    readonly retryAfterSeconds?: number | null;
    readonly details?: Record<string, unknown>;
  };
}

const failureBody = async (response: Response): Promise<FailureEnvelope> =>
  (await response.json()) as FailureEnvelope;

describe("raw header 单例规则（契约 §6.1）", () => {
  it("九个认证 header 缺任意一个都在进入 verifier 前以 401 拒绝", async () => {
    const bed = await createTestBed();
    try {
      const names = [
        "Authorization",
        "X-Open-Android-Intelligence-Protocol",
        "X-Open-Android-Intelligence-Account",
        "X-Open-Android-Intelligence-Device",
        "X-Open-Android-Intelligence-Session",
        "X-Open-Android-Intelligence-Request-Id",
        "X-Open-Android-Intelligence-Timestamp",
        "X-Open-Android-Intelligence-Nonce",
        "X-Open-Android-Intelligence-Signature",
      ];
      for (const name of names) {
        const response = await gatewayFetch(bed, "/open-android-intelligence/v2/conversations", {
          headers: buildAuthHeaders({ omit: [name] }),
        });
        expect(response.status, `missing ${name}`).toBe(401);
        const body = await failureBody(response);
        expect(body.error?.code, `missing ${name}`).toBe("AUTHENTICATION_REQUIRED");
      }
      expect(bed.verifier.verifyCalls).toHaveLength(0);
      expect(bed.core.calls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("重复的认证 header（即使值相同）拒绝，且不进入 verifier", async () => {
    const bed = await createTestBed();
    try {
      const headers = Object.entries(buildAuthHeaders()).flatMap(([name, value]) => [[name, value] as [string, string]]);
      const response = await rawHttpRequest(bed, {
        method: "GET",
        path: "/open-android-intelligence/v2/conversations",
        headers: [...headers, ["Authorization", "Bearer second-token"]],
      });
      expect(response.status).toBe(401);
      const body = JSON.parse(response.body) as FailureEnvelope;
      expect(body.error?.code).toBe("AUTHENTICATION_REQUIRED");
      expect(bed.verifier.verifyCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("逗号折叠的认证 header 值拒绝（Authorization 中出现逗号）", async () => {
    const bed = await createTestBed();
    try {
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/conversations", {
        headers: buildAuthHeaders({
          overrides: { Authorization: "Bearer token-a, Bearer token-b" },
        }),
      });
      expect(response.status).toBe(401);
      const body = await failureBody(response);
      expect(body.error?.code).toBe("AUTHENTICATION_REQUIRED");
      expect(bed.verifier.verifyCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("认证 GET 带 Idempotency-Key 拒绝", async () => {
    const bed = await createTestBed();
    try {
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/conversations", {
        headers: buildAuthHeaders({ idempotencyKey: FAKE_REQUEST_ID }),
      });
      expect(response.status).toBe(400);
      const body = await failureBody(response);
      expect(body.error?.code).toBe("SCHEMA_INVALID");
      expect(bed.verifier.verifyCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("认证的 POST 缺 Idempotency-Key 拒绝", async () => {
    const bed = await createTestBed();
    try {
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/conversations", {
        method: "POST",
        headers: { ...buildAuthHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect((await failureBody(response)).error?.code).toBe("SCHEMA_INVALID");
      expect(bed.verifier.verifyCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("重复 Idempotency-Key 拒绝", async () => {
    const bed = await createTestBed();
    try {
      const headers = Object.entries(buildMutationHeaders()).flatMap(([name, value]) => [[name, value] as [string, string]]);
      const response = await rawHttpRequest(bed, {
        method: "POST",
        path: "/open-android-intelligence/v2/conversations",
        headers: [
          ...headers,
          ["Content-Type", "application/json"],
          ["Content-Length", "2"],
          ["Idempotency-Key", FAKE_REQUEST_ID],
        ],
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect((JSON.parse(response.body) as FailureEnvelope).error?.code).toBe("SCHEMA_INVALID");
      expect(bed.verifier.verifyCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("Last-Event-ID 只允许出现在 GET /events", async () => {
    const bed = await createTestBed();
    try {
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/conversations", {
        headers: { ...buildAuthHeaders(), "Last-Event-ID": "evt_1" },
      });
      expect(response.status).toBe(400);
      expect((await failureBody(response)).error?.code).toBe("SCHEMA_INVALID");
      expect(bed.verifier.verifyCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("登出路径只要求 Bearer + 五个身份 header，不要求签名四件套", async () => {
    const bed = await createTestBed();
    try {
      const response = await gatewayFetch(
        bed,
        "/open-android-intelligence/v2/sessions/current?revokeRefresh=true",
        { method: "DELETE", headers: buildLogoutHeaders() },
      );
      expect(response.status).toBe(200);
      expect(bed.verifier.logoutCalls).toHaveLength(1);
      expect(bed.verifier.verifyCalls).toHaveLength(0);
      expect(bed.core.calls.map((call) => call.operation)).toEqual(["logout"]);
      const body = (await response.json()) as { protocol?: string; data?: unknown };
      expect(body.protocol).toBe("2.1");
    } finally {
      await bed.server.close();
    }
  });

  it("登出缺 Authorization 仍然 401", async () => {
    const bed = await createTestBed();
    try {
      const headers = buildLogoutHeaders();
      delete headers["Authorization"];
      const response = await gatewayFetch(
        bed,
        "/open-android-intelligence/v2/sessions/current?revokeRefresh=false",
        { method: "DELETE", headers },
      );
      expect(response.status).toBe(401);
      expect((await failureBody(response)).error?.code).toBe("AUTHENTICATION_REQUIRED");
      expect(bed.verifier.logoutCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });
});

describe("raw header 解析单元规则", () => {
  it("拿不到 raw header 列表时失败关闭", () => {
    expect(() => collectRawHeaders(undefined)).toThrow(GatewayError);
    expect(() => collectRawHeaders(["Authorization"])).toThrow(GatewayError);
    try {
      collectRawHeaders(undefined);
    } catch (error) {
      expect((error as GatewayError).code).toBe("AUTHENTICATION_REQUIRED");
    }
  });

  it("保留重复、顺序与原始大小写", () => {
    const headers = collectRawHeaders(["Authorization", "Bearer a", "X-Test", "  1  "]);
    expect(headers).toEqual([
      { name: "Authorization", value: "Bearer a" },
      { name: "X-Test", value: "  1  " },
    ]);
  });

  it("控制字符、需要 trim 的值、逗号折叠值都拒绝", () => {
    const expectCode = (headers: { name: string; value: string }[], code: string) => {
      try {
        validateContractHeaders(headers);
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(GatewayError);
        expect((error as GatewayError).code).toBe(code);
      }
    };
    // 认证 header → 401 语义
    expectCode([{ name: "Authorization", value: "Bearer a\u0001b" }], "AUTHENTICATION_REQUIRED");
    expectCode([{ name: "Authorization", value: " Bearer a" }], "AUTHENTICATION_REQUIRED");
    expectCode([{ name: "Authorization", value: "Bearer a, Bearer b" }], "AUTHENTICATION_REQUIRED");
    expectCode(
      [
        { name: "X-Open-Android-Intelligence-Nonce", value: "a" },
        { name: "x-open-android-intelligence-nonce", value: "a" },
      ],
      "AUTHENTICATION_REQUIRED",
    );
    // 条件 header → 400 语义
    expectCode([{ name: "Content-Type", value: "application/json, application/json" }], "SCHEMA_INVALID");
    expectCode([{ name: "Idempotency-Key", value: "req_1\u0000" }], "SCHEMA_INVALID");
    expectCode(
      [
        { name: "Digest", value: "sha-256=a" },
        { name: "Digest", value: "sha-256=a" },
      ],
      "SCHEMA_INVALID",
    );
  });
});
