import { describe, expect, it } from "vitest";

import { createTestBed } from "./helpers.js";

const MOUNT = "/open-android-intelligence/v2";
const cases = [
  [`${MOUNT}/sessions/invite/challenge`, "inviteChallenge"],
  [`${MOUNT}/pairings/exchange`, "inviteExchange"],
  [`${MOUNT}/sessions/device/challenge`, "deviceChallenge"],
  [`${MOUNT}/sessions/device`, "deviceLogin"],
] as const;

describe("邀请配对与设备密钥的预认证路由", () => {
  for (const [path, operation] of cases) {
    it(`POST ${path} 直接进入 ${operation}，不需要签名 header`, async () => {
      const bed = await createTestBed();
      try {
        bed.core.result = { status: 200, data: { ok: true } };
        const response = await fetch(bed.url(path), {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ probe: true }),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { data: { ok: boolean } };
        expect(body.data.ok).toBe(true);
        const call = bed.core.calls.at(-1);
        expect(call?.operation).toBe(operation);
        expect(call?.request.method).toBe("POST");
      } finally {
        await bed.server.close();
      }
    });
  }

  it("非 JSON 内容类型被拒绝且不进入业务", async () => {
    const bed = await createTestBed();
    try {
      const response = await fetch(bed.url(`${MOUNT}/sessions/invite/challenge`), {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "nope",
      });
      expect(response.status).toBe(400);
      expect(bed.core.calls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });
});
