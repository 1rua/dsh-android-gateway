import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  FAKE_REQUEST_ID,
  buildAuthHeaders,
  buildMutationHeaders,
  createTestBed,
  gatewayFetch,
  rawHttpRequest,
} from "./helpers.js";

interface ErrorEnvelope {
  readonly requestId: string;
  readonly correlationId: string;
  readonly protocol: string;
  readonly error: {
    readonly code: string;
    readonly details: Record<string, unknown>;
  };
}

interface SuccessEnvelope {
  readonly protocol: string;
  readonly data: Record<string, unknown>;
}

const JSON_PATH = "/open-android-intelligence/v2/conversations";

describe("JSON entity-body 的传输规则", () => {
  it("Content-Type 必须精确等于 application/json", async () => {
    const bed = await createTestBed();
    try {
      for (const contentType of ["text/plain", "application/json; charset=utf-8", "Application/JSON"]) {
        const response = await gatewayFetch(bed, JSON_PATH, {
          method: "POST",
          headers: { ...buildMutationHeaders(), "Content-Type": contentType },
          body: "{}",
        });
        expect(response.status, contentType).toBe(400);
        const body = (await response.json()) as ErrorEnvelope;
        expect(body.error.code, contentType).toBe("SCHEMA_INVALID");
      }
      expect(bed.verifier.verifyCalls).toHaveLength(0);
      expect(bed.core.calls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("有 body 却没有 Content-Type 拒绝", async () => {
    const bed = await createTestBed();
    try {
      const headers = buildMutationHeaders();
      const response = await gatewayFetch(bed, JSON_PATH, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("SCHEMA_INVALID");
      expect(bed.verifier.verifyCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("拒绝 Content-Encoding（JSON 请求禁止内容压缩）", async () => {
    const bed = await createTestBed();
    try {
      const response = await gatewayFetch(bed, JSON_PATH, {
        method: "POST",
        headers: {
          ...buildMutationHeaders(),
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
        },
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("SCHEMA_INVALID");
      expect(bed.verifier.verifyCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("跳过 Content-Length 上限校验前的 body 字节不进入业务", async () => {
    const bed = await createTestBed({ maxJsonBodyBytes: 32 });
    try {
      const response = await gatewayFetch(bed, JSON_PATH, {
        method: "POST",
        headers: { ...buildMutationHeaders(), "Content-Type": "application/json" },
        body: "x".repeat(64),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.code).toBe("SCHEMA_INVALID");
      expect(body.error.details).toMatchObject({ limitBytes: 32 });
      expect(bed.verifier.verifyCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("原始 body 字节与 bodyText 原样交给 verifier/core（不做 JSON 规范化）", async () => {
    const bed = await createTestBed();
    try {
      const rawBody = '{ "title" : "保留  空格", "n": 1 }';
      const response = await gatewayFetch(bed, JSON_PATH, {
        method: "POST",
        headers: { ...buildMutationHeaders(), "Content-Type": "application/json" },
        body: rawBody,
      });
      expect(response.status).toBe(200);
      const verifyCall = bed.verifier.verifyCalls[0];
      expect(verifyCall).toBeDefined();
      expect(Buffer.from(verifyCall?.body as Uint8Array).toString("utf8")).toBe(rawBody);
      expect(verifyCall?.bodyText).toBe(rawBody);
      expect(verifyCall?.json).toEqual({ title: "保留  空格", n: 1 });
      expect(bed.core.calls[0]?.operation).toBe("handle");
    } finally {
      await bed.server.close();
    }
  });

  it("chunked JSON body 超过 maxJsonBodyBytes 时拒绝", async () => {
    const bed = await createTestBed({ maxJsonBodyBytes: 8 });
    try {
      const body = '{"too":"long"}';
      const headers = Object.entries(buildMutationHeaders()).flatMap(([name, value]) => [[name, value] as [string, string]]);
      const response = await rawHttpRequest(bed, {
        method: "POST",
        path: JSON_PATH,
        headers: [
          ...headers,
          ["Content-Type", "application/json"],
          ["Transfer-Encoding", "chunked"],
        ],
        body: `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`,
      });
      expect(response.status).toBe(400);
      expect((JSON.parse(response.body) as ErrorEnvelope).error.code).toBe("SCHEMA_INVALID");
      expect(bed.verifier.verifyCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("预认证 JSON 路由同样要求 Content-Type 精确为 application/json", async () => {
    const bed = await createTestBed();
    try {
      const response = await gatewayFetch(bed, "/open-android-intelligence/v2/negotiate", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("SCHEMA_INVALID");
      expect(bed.core.calls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("chunked JSON body（无 Content-Length）按 transfer framing 解码后原样交付", async () => {
    const bed = await createTestBed();
    try {
      const body = '{"chunked":true}';
      const headers = Object.entries(buildMutationHeaders()).flatMap(([name, value]) => [[name, value] as [string, string]]);
      const response = await rawHttpRequest(bed, {
        method: "POST",
        path: JSON_PATH,
        headers: [
          ...headers,
          ["Content-Type", "application/json"],
          ["Transfer-Encoding", "chunked"],
        ],
        body: `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`,
      });
      expect(response.status).toBe(200);
      const verifyCall = bed.verifier.verifyCalls[0];
      expect(Buffer.from(verifyCall?.body as Uint8Array).toString("utf8")).toBe(body);
    } finally {
      await bed.server.close();
    }
  });

  it("无 body 的认证 GET 不允许 Content-Type / Content-Length", async () => {
    const bed = await createTestBed();
    try {
      const headerSets: Array<Array<[string, string]>> = [
        [
          ...Object.entries(buildAuthHeaders()),
          ["Content-Type", "application/json"],
        ],
        [
          ...Object.entries(buildAuthHeaders()),
          ["Content-Length", "0"],
        ],
      ];
      for (const headers of headerSets) {
        const response = await rawHttpRequest(bed, { method: "GET", path: JSON_PATH, headers });
        expect(response.status).toBe(400);
        expect((JSON.parse(response.body) as ErrorEnvelope).error.code).toBe("SCHEMA_INVALID");
      }
      expect(bed.verifier.verifyCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("GET 认证请求把 method/path/query 原样交给 core.handle", async () => {
    const bed = await createTestBed();
    try {
      bed.core.result = { status: 200, data: { conversations: [] } };
      const response = await gatewayFetch(
        bed,
        `${JSON_PATH}?cursor=cur_1&limit=20`,
        { headers: buildAuthHeaders() },
      );
      expect(response.status).toBe(200);
      const verified = bed.core.calls[0]?.request;
      expect(verified).toBeDefined();
      if (verified !== undefined && "path" in verified) {
        expect(verified.method).toBe("GET");
        expect(verified.path).toBe(JSON_PATH);
        expect(verified.query.get("cursor")).toBe("cur_1");
        expect(verified.query.get("limit")).toBe("20");
      }
    } finally {
      await bed.server.close();
    }
  });

  it("core 返回的 status 优先（例如 202）", async () => {
    const bed = await createTestBed();
    try {
      bed.core.result = { status: 202, data: { accepted: true } };
      const response = await gatewayFetch(bed, JSON_PATH, {
        method: "POST",
        headers: { ...buildMutationHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as SuccessEnvelope;
      expect(body.protocol).toBe("2.1");
      expect(body.data).toEqual({ accepted: true });
    } finally {
      await bed.server.close();
    }
  });

  it("认证 POST 的 Idempotency-Key 值原样传给 verifier（是否等于 requestId 由业务判定）", async () => {
    const bed = await createTestBed();
    try {
      const response = await gatewayFetch(bed, JSON_PATH, {
        method: "POST",
        headers: {
          ...buildAuthHeaders({ idempotencyKey: "key_not_equal" }),
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(response.status).toBe(200);
      const verifyCall = bed.verifier.verifyCalls[0];
      const idempotency = (verifyCall?.headers ?? [])
        .filter((header) => header.name.toLowerCase() === "idempotency-key")
        .map((header) => header.value);
      expect(idempotency).toEqual(["key_not_equal"]);
      expect(verifyCall?.headers.some((header) => header.name === "X-Open-Android-Intelligence-Request-Id" && header.value === FAKE_REQUEST_ID)).toBe(true);
    } finally {
      await bed.server.close();
    }
  });
});

describe("附件路由之外的 Digest / body 限制", () => {
  it("非附件路由出现 Digest 拒绝", async () => {
    const bed = await createTestBed();
    try {
      const response = await gatewayFetch(bed, JSON_PATH, {
        headers: {
          ...buildAuthHeaders(),
          Digest: `sha-256=${createHash("sha256").update("").digest("base64")}`,
        },
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("SCHEMA_INVALID");
    } finally {
      await bed.server.close();
    }
  });
});
