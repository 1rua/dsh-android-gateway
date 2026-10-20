import { describe, expect, it } from "vitest";

import { GatewayError } from "../../src/shared/errors.js";
import {
  buildAuthHeaders,
  createTestBed,
  expectedSseFrame,
  gatewayFetch,
  makeEvent,
  rawHttpRequest,
  waitUntil,
  SseClient,
} from "./helpers.js";

const EVENTS_PATH = "/open-android-intelligence/v2/events";

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
  };
}

describe("SSE 事件流", () => {
  it("先写 replay 帧、再订阅；帧格式与顺序符合契约 §9", async () => {
    const bed = await createTestBed();
    const controller = new AbortController();
    try {
      const first = makeEvent({
        eventId: "evt_1",
        type: "conversation.message.delta",
        correlationId: "cor_1",
        payload: { conversationId: "conv_1", text: "第一段" },
      });
      const second = makeEvent({
        eventId: "evt_2",
        type: "conversation.message.completed",
        seq: 2,
        correlationId: "cor_2",
        occurredAt: "2026-10-20T00:00:01.000Z",
        payload: { messageId: "msg_1" },
      });
      bed.events.replay = [first, second];

      const response = await gatewayFetch(bed, `${EVENTS_PATH}?cursor=evt_0`, {
        headers: { ...buildAuthHeaders(), Accept: "text/event-stream" },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("connection")).toBe("keep-alive");
      expect(bed.events.openCalls).toEqual([{ accountId: "acct_1", cursor: "evt_0" }]);
      expect(bed.events.subscriberCount).toBe(1);

      const client = new SseClient(response);
      const text = await client.waitFor(
        (value) => value.includes("id: evt_1") && value.includes("id: evt_2"),
      );

      const expectedFirst = expectedSseFrame(first);
      const expectedSecond = expectedSseFrame(second);
      expect(text).toContain(expectedFirst);
      expect(text).toContain(expectedSecond);
      expect(text.indexOf("id: evt_1")).toBeLessThan(text.indexOf("id: evt_2"));

      // data 只允许 correlationId / occurredAt / payload 三个字段。
      const dataLine = text
        .split("\n")
        .find((line) => line.startsWith("data: "));
      const data = JSON.parse((dataLine as string).slice("data: ".length)) as Record<string, unknown>;
      expect(Object.keys(data).sort()).toEqual(["correlationId", "occurredAt", "payload"]);

      await client.cancel();
    } finally {
      controller.abort();
      await bed.server.close();
    }
  });

  it("实时事件在 replay 之后按订阅推送", async () => {
    const bed = await createTestBed();
    const controller = new AbortController();
    try {
      const replay = makeEvent({ eventId: "evt_1", type: "conversation.message.delta" });
      const live = makeEvent({
        eventId: "evt_2",
        type: "conversation.message.status",
        seq: 2,
        payload: { status: "completed" },
      });
      bed.events.replay = [replay];

      const response = await gatewayFetch(bed, `${EVENTS_PATH}?cursor=evt_0`, {
        headers: { ...buildAuthHeaders(), Accept: "text/event-stream" },
        signal: controller.signal,
      });
      const client = new SseClient(response);
      await client.waitFor((value) => value.includes("id: evt_1"));
      await waitUntil(() => bed.events.subscriberCount === 1);
      bed.events.emit(live);
      const text = await client.waitFor((value) => value.includes("id: evt_2"));
      expect(text.indexOf("id: evt_1")).toBeLessThan(text.indexOf("id: evt_2"));
      expect(text).toContain(expectedSseFrame(live));
      await client.cancel();
    } finally {
      controller.abort();
      await bed.server.close();
    }
  });

  it("心跳使用注释行 : ping，不创建事件 ID", async () => {
    const bed = await createTestBed({ heartbeatMs: 80 });
    const controller = new AbortController();
    try {
      bed.events.replay = [];
      const response = await gatewayFetch(bed, `${EVENTS_PATH}?cursor=evt_0`, {
        headers: { ...buildAuthHeaders(), Accept: "text/event-stream" },
        signal: controller.signal,
      });
      const client = new SseClient(response);
      const text = await client.waitFor((value) => value.includes(": ping\n\n"));
      expect(text).toContain(": ping\n\n");
      expect(text).not.toContain("id:");
      await client.cancel();
    } finally {
      controller.abort();
      await bed.server.close();
    }
  });

  it("客户端断开时清理订阅", async () => {
    const bed = await createTestBed();
    const controller = new AbortController();
    try {
      bed.events.replay = [makeEvent({ eventId: "evt_1", type: "gateway.notice" })];
      const response = await gatewayFetch(bed, `${EVENTS_PATH}?cursor=evt_0`, {
        headers: { ...buildAuthHeaders(), Accept: "text/event-stream" },
        signal: controller.signal,
      });
      const client = new SseClient(response);
      await client.waitFor((value) => value.includes("id: evt_1"));
      expect(bed.events.subscriberCount).toBe(1);

      controller.abort();
      await client.cancel();
      await waitUntil(() => bed.events.unsubscribeCount === 1);
      expect(bed.events.subscriberCount).toBe(0);
    } finally {
      controller.abort();
      await bed.server.close();
    }
  });

  it("Last-Event-ID 与 query cursor 逐字节相等时使用该 cursor", async () => {
    const bed = await createTestBed();
    const controller = new AbortController();
    try {
      bed.events.replay = [makeEvent({ eventId: "evt_2", type: "gateway.notice" })];
      const response = await gatewayFetch(bed, `${EVENTS_PATH}?cursor=evt_1`, {
        headers: {
          ...buildAuthHeaders(),
          Accept: "text/event-stream",
          "Last-Event-ID": "evt_1",
        },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(bed.events.openCalls).toEqual([{ accountId: "acct_1", cursor: "evt_1" }]);
      const client = new SseClient(response);
      await client.waitFor((value) => value.includes("id: evt_2"));
      await client.cancel();
    } finally {
      controller.abort();
      await bed.server.close();
    }
  });

  it("Last-Event-ID 与 cursor 不一致返回 409 CURSOR_CONFLICT，且不打开事件流", async () => {
    const bed = await createTestBed();
    try {
      const response = await gatewayFetch(bed, `${EVENTS_PATH}?cursor=evt_1`, {
        headers: {
          ...buildAuthHeaders(),
          Accept: "text/event-stream",
          "Last-Event-ID": "evt_2",
        },
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("CURSOR_CONFLICT");
      expect(bed.events.openCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("只有 Last-Event-ID、没有 query cursor（即使不带 Accept）返回 409", async () => {
    const bed = await createTestBed();
    try {
      const response = await gatewayFetch(bed, EVENTS_PATH, {
        headers: { ...buildAuthHeaders(), "Last-Event-ID": "evt_1" },
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("CURSOR_CONFLICT");
      expect(bed.events.openCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });

  it("query 含 cursor 即选择 SSE（即使 Accept 不是 text/event-stream）", async () => {
    const bed = await createTestBed();
    const controller = new AbortController();
    try {
      bed.events.replay = [makeEvent({ eventId: "evt_2", type: "gateway.notice" })];
      const response = await gatewayFetch(bed, `${EVENTS_PATH}?cursor=evt_1`, {
        headers: { ...buildAuthHeaders(), Accept: "application/json" },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(bed.events.openCalls).toHaveLength(1);
      expect(bed.core.calls).toHaveLength(0);
      const client = new SseClient(response);
      await client.waitFor((value) => value.includes("id: evt_2"));
      await client.cancel();
    } finally {
      controller.abort();
      await bed.server.close();
    }
  });

  it("GET /events 无 SSE 要求时回退为 JSON 事件列表（core.handle）", async () => {
    const bed = await createTestBed();
    try {
      bed.core.result = { status: 200, data: { events: [] } };
      const response = await gatewayFetch(bed, EVENTS_PATH, {
        headers: { ...buildAuthHeaders(), Accept: "application/json" },
      });
      expect(response.status).toBe(200);
      expect((await response.json()) as { data: { events: unknown[] } }).toBeDefined();
      expect(bed.events.openCalls).toHaveLength(0);
      expect(bed.core.calls[0]?.operation).toBe("handle");
    } finally {
      await bed.server.close();
    }
  });

  it("事件服务抛 CURSOR_EXPIRED 时返回 410 信封", async () => {
    const bed = await createTestBed();
    try {
      bed.events.openError = new GatewayError("CURSOR_EXPIRED", "Cursor is too old", {
        details: { recoverableResources: ["conversations", "attachments", "device-requests"] },
      });
      const response = await gatewayFetch(bed, `${EVENTS_PATH}?cursor=evt_old`, {
        headers: { ...buildAuthHeaders(), Accept: "text/event-stream" },
      });
      expect(response.status).toBe(410);
      const body = (await response.json()) as {
        error: { code: string; details: Record<string, unknown> };
      };
      expect(body.error.code).toBe("CURSOR_EXPIRED");
      expect(body.error.details).toEqual({
        recoverableResources: ["conversations", "attachments", "device-requests"],
      });
    } finally {
      await bed.server.close();
    }
  });
});

describe("SSE 与 raw header 的交互", () => {
  it("GET /events 的 Last-Event-ID 重复按 SCHEMA_INVALID 拒绝", async () => {
    const bed = await createTestBed();
    try {
      const headers = Object.entries(buildAuthHeaders()).flatMap(([name, value]) => [[name, value] as [string, string]]);
      const response = await rawHttpRequest(bed, {
        method: "GET",
        path: `${EVENTS_PATH}?cursor=evt_1`,
        headers: [
          ...headers,
          ["Accept", "text/event-stream"],
          ["Last-Event-ID", "evt_1"],
          ["Last-Event-ID", "evt_2"],
        ],
      });
      expect(response.status).toBe(400);
      expect((JSON.parse(response.body) as ErrorEnvelope).error.code).toBe("SCHEMA_INVALID");
      expect(bed.events.openCalls).toHaveLength(0);
    } finally {
      await bed.server.close();
    }
  });
});
