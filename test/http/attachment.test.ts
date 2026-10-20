import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import { GatewayError } from "../../src/shared/errors.js";
import {
  FAKE_REQUEST_ID,
  buildMutationHeaders,
  createTestBed,
  rawHttpRequest,
  waitUntil,
} from "./helpers.js";

const CONTENT_PATH = "/open-android-intelligence/v2/attachments/att_1/content";

interface ErrorEnvelope {
  readonly error: { readonly code: string };
}

interface SuccessEnvelope {
  readonly requestId: string;
  readonly correlationId: string;
  readonly protocol: string;
  readonly data: Record<string, unknown>;
}

const sha256Hex = (body: Buffer): string => createHash("sha256").update(body).digest("hex");
const digestHeader = (body: Buffer): string =>
  `sha-256=${createHash("sha256").update(body).digest("base64")}`;

const baseHeaders = (): Array<[string, string]> =>
  Object.entries(buildMutationHeaders()).map(([name, value]) => [name, value]);

describe("PUT /attachments/{id}/content", () => {
  it("流式落盘、校验 Content-Length 与 Digest，把正确 sha256 交给 core，并清理临时目录", async () => {
    const bed = await createTestBed();
    try {
      const body = Buffer.from("hello attachment bytes");
      const staged: { path: string | null; bytes: Buffer | null } = { path: null, bytes: null };
      bed.core.result = {
        status: 200,
        data: { attachment: { attachmentId: "att_1", status: "uploaded" } },
      };
      bed.core.uploadProbe = (upload) => {
        staged.path = upload.filePath;
        staged.bytes = readFileSync(upload.filePath);
        expect(upload.contentLength).toBe(body.byteLength);
        expect(upload.sha256Hex).toBe(sha256Hex(body));
      };

      const response = await rawHttpRequest(bed, {
        method: "PUT",
        path: CONTENT_PATH,
        headers: [
          ...baseHeaders(),
          ["Content-Type", "application/pdf"],
          ["Content-Length", String(body.byteLength)],
          ["Digest", digestHeader(body)],
        ],
        body: body.toString("utf8"),
      });

      expect(response.status).toBe(200);
      const envelope = JSON.parse(response.body) as SuccessEnvelope;
      expect(envelope.protocol).toBe("2.1");
      expect(envelope.requestId).toBe(FAKE_REQUEST_ID);
      expect(envelope.data).toEqual({
        attachment: { attachmentId: "att_1", status: "uploaded" },
      });
      expect(staged.bytes).not.toBeNull();
      expect((staged.bytes as Buffer).toString("utf8")).toBe(body.toString("utf8"));
      expect(staged.path).not.toBeNull();

      // 签名预像使用 Digest 声明的摘要：verifier 收到空 body + 64 位小写 hex。
      const verifyCall = bed.verifier.verifyCalls[0];
      expect(verifyCall?.body.byteLength).toBe(0);
      expect(verifyCall?.declaredBodyDigestHex).toBe(sha256Hex(body));
      expect(verifyCall?.target).toBe(CONTENT_PATH);

      expect(bed.core.calls.map((call) => call.operation)).toEqual(["uploadAttachmentContent"]);
      await waitUntil(() => staged.path !== null && !existsSync(dirname(staged.path)));
    } finally {
      await bed.server.close();
    }
  });

  it("实际字节与 Digest 不一致时返回 400 ATTACHMENT_DIGEST_MISMATCH，不调用 core 并清理", async () => {
    const bed = await createTestBed();
    try {
      const body = Buffer.from("actual bytes");
      const wrongDigest = digestHeader(Buffer.from("different bytes"));
      // core 不会被调用，拿不到 staging 路径，改为观察 os.tmpdir() 下本层前缀目录最终不残留。
      const before = listUploadDirectories();
      const response = await rawHttpRequest(bed, {
        method: "PUT",
        path: CONTENT_PATH,
        headers: [
          ...baseHeaders(),
          ["Content-Length", String(body.byteLength)],
          ["Digest", wrongDigest],
        ],
        body: body.toString("utf8"),
      });
      expect(response.status).toBe(400);
      expect((JSON.parse(response.body) as ErrorEnvelope).error.code).toBe("ATTACHMENT_DIGEST_MISMATCH");
      expect(bed.core.calls).toHaveLength(0);
      await waitUntil(() => listUploadDirectories().length <= before.length);
    } finally {
      await bed.server.close();
    }
  });

  it("缺少 Digest / Digest 格式错误 / 缺少 Content-Length 都返回 400 SCHEMA_INVALID", async () => {
    const bed = await createTestBed();
    try {
      const body = Buffer.from("abc");
      const cases: Array<{
        label: string;
        headers: Array<[string, string]>;
        body: string;
      }> = [
        {
          label: "missing digest",
          headers: [...baseHeaders(), ["Content-Length", String(body.byteLength)]],
          body: body.toString("utf8"),
        },
        {
          label: "bad digest",
          headers: [
            ...baseHeaders(),
            ["Content-Length", String(body.byteLength)],
            ["Digest", "sha-256=not-base64"],
          ],
          body: body.toString("utf8"),
        },
        {
          label: "missing content-length",
          headers: [...baseHeaders(), ["Digest", digestHeader(body)]],
          // 没有 Content-Length/Transfer-Encoding 时 entity-body 不存在，勿发送字节。
          body: "",
        },
      ];
      for (const testCase of cases) {
        const response = await rawHttpRequest(bed, {
          method: "PUT",
          path: CONTENT_PATH,
          headers: testCase.headers,
          body: testCase.body,
        });
        expect(response.status, testCase.label).toBe(400);
        expect((JSON.parse(response.body) as ErrorEnvelope).error.code, testCase.label).toBe(
          "SCHEMA_INVALID",
        );
      }
      expect(bed.verifier.verifyCalls).toHaveLength(0);
      expect(bed.core.calls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("拒绝 Transfer-Encoding（附件必须固定长度、禁止 chunked）", async () => {
    const bed = await createTestBed();
    try {
      const body = Buffer.from("chunked");
      const response = await rawHttpRequest(bed, {
        method: "PUT",
        path: CONTENT_PATH,
        headers: [
          ...baseHeaders(),
          ["Transfer-Encoding", "chunked"],
          ["Digest", digestHeader(body)],
        ],
        body: `${body.byteLength.toString(16)}\r\n${body.toString("utf8")}\r\n0\r\n\r\n`,
      });
      expect(response.status).toBe(400);
      expect((JSON.parse(response.body) as ErrorEnvelope).error.code).toBe("SCHEMA_INVALID");
      expect(bed.core.calls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("重复 Digest 拒绝", async () => {
    const bed = await createTestBed();
    try {
      const body = Buffer.from("abc");
      const response = await rawHttpRequest(bed, {
        method: "PUT",
        path: CONTENT_PATH,
        headers: [
          ...baseHeaders(),
          ["Content-Length", String(body.byteLength)],
          ["Digest", digestHeader(body)],
          ["Digest", digestHeader(body)],
        ],
        body: body.toString("utf8"),
      });
      expect(response.status).toBe(400);
      expect((JSON.parse(response.body) as ErrorEnvelope).error.code).toBe("SCHEMA_INVALID");
      expect(bed.verifier.verifyCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("声明的 Content-Length 超过 maxAttachmentBytes 时提前拒绝，不落盘", async () => {
    const bed = await createTestBed({ maxAttachmentBytes: 8 });
    try {
      const body = Buffer.from("0123456789");
      const before = listUploadDirectories();
      const response = await rawHttpRequest(bed, {
        method: "PUT",
        path: CONTENT_PATH,
        headers: [
          ...baseHeaders(),
          ["Content-Length", String(body.byteLength)],
          ["Digest", digestHeader(body)],
        ],
        body: body.toString("utf8"),
      });
      expect(response.status).toBe(400);
      expect((JSON.parse(response.body) as ErrorEnvelope).error.code).toBe("SCHEMA_INVALID");
      expect(bed.verifier.verifyCalls).toHaveLength(0);
      expect(listUploadDirectories().length).toBe(before.length);
    } finally {
      await bed.server.close();
    }
  });

  it("Content-Type 允许 0 或 1 次；mediaType 一致性由 core 校验", async () => {
    const bed = await createTestBed();
    try {
      const body = Buffer.from("no content type");
      bed.core.result = { status: 200, data: { attachment: { status: "uploaded" } } };
      const response = await rawHttpRequest(bed, {
        method: "PUT",
        path: CONTENT_PATH,
        headers: [
          ...baseHeaders(),
          ["Content-Length", String(body.byteLength)],
          ["Digest", digestHeader(body)],
        ],
        body: body.toString("utf8"),
      });
      expect(response.status).toBe(200);
      expect(bed.core.calls).toHaveLength(1);

      const withMediaType = Buffer.from("with content type");
      const response2 = await rawHttpRequest(bed, {
        method: "PUT",
        path: CONTENT_PATH,
        headers: [
          ...baseHeaders(),
          ["Content-Type", "image/png"],
          ["Content-Length", String(withMediaType.byteLength)],
          ["Digest", digestHeader(withMediaType)],
        ],
        body: withMediaType.toString("utf8"),
      });
      expect(response2.status).toBe(200);
      expect(bed.core.calls).toHaveLength(2);
    } finally {
      await bed.server.close();
    }
  });

  it("验签失败时先返回 401，不消费 body、不调用 core", async () => {
    const bed = await createTestBed();
    try {
      const body = Buffer.from("secret bytes");
      bed.verifier.verifyError = new GatewayError("SIGNATURE_INVALID");
      const response = await rawHttpRequest(bed, {
        method: "PUT",
        path: CONTENT_PATH,
        headers: [
          ...baseHeaders(),
          ["Content-Length", String(body.byteLength)],
          ["Digest", digestHeader(body)],
        ],
        body: body.toString("utf8"),
      });
      expect(response.status).toBe(401);
      expect((JSON.parse(response.body) as ErrorEnvelope).error.code).toBe("SIGNATURE_INVALID");
      expect(bed.core.calls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("core 失败时仍然清理临时目录", async () => {
    const bed = await createTestBed();
    try {
      const body = Buffer.from("core failure bytes");
      let stagedPath: string | null = null;
      bed.core.uploadProbe = (upload) => {
        stagedPath = upload.filePath;
      };
      bed.core.errors.set(
        "uploadAttachmentContent",
        new GatewayError("ATTACHMENT_STORAGE_UNAVAILABLE"),
      );
      const response = await rawHttpRequest(bed, {
        method: "PUT",
        path: CONTENT_PATH,
        headers: [
          ...baseHeaders(),
          ["Content-Length", String(body.byteLength)],
          ["Digest", digestHeader(body)],
        ],
        body: body.toString("utf8"),
      });
      expect(response.status).toBe(400);
      expect((JSON.parse(response.body) as ErrorEnvelope).error.code).toBe(
        "ATTACHMENT_STORAGE_UNAVAILABLE",
      );
      await waitUntil(() => stagedPath !== null && !existsSync(dirname(stagedPath)));
    } finally {
      await bed.server.close();
    }
  });
});

/** 临时目录前缀由实现约定；仅用于断言“最终没有残留”的测试。 */
const listUploadDirectories = (): string[] =>
  readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("dsh-android-gateway-upload-"))
    .map((entry) => entry.name);
