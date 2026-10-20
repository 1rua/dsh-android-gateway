import type { IncomingMessage, ServerResponse } from "node:http";

import type { EventRecord } from "../shared/types.js";

import type { EventSubscription } from "./contract.js";

/** 契约 §9：SSE 响应头。任务要求 cache-control 使用 no-store。 */
export const SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  Connection: "keep-alive",
  // 反向代理不得缓冲事件流（例如 nginx）。
  "X-Accel-Buffering": "no",
};

/** 心跳是 SSE 注释行，不创建事件 ID（契约 §9）。 */
export const SSE_HEARTBEAT_FRAME = ": ping\n\n";

/**
 * 单条事件帧：
 * `id: <eventId>\nevent: <type>\ndata: {"correlationId","occurredAt","payload"}\n\n`。
 * data 的 JSON 只有契约 §9 规定的三个字段，type 由 event 行承载。
 */
export const encodeSseEventFrame = (event: EventRecord): string => {
  const data = JSON.stringify({
    correlationId: event.correlationId,
    occurredAt: event.occurredAt,
    payload: event.payload,
  });
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${data}\n\n`;
};

export interface SseStreamOptions {
  readonly heartbeatMs: number;
  readonly logger?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

/**
 * 把一条订阅写成 SSE 长连接。
 *
 * 顺序固定：先写 headers → 写 replay 帧 → 再挂实时 listener；
 * 任何写入失败或连接关闭都清理 heartbeat 与订阅。函数在连接关闭前不会 resolve，
 * 这样插件宿主能感知这条长连接的完整生命周期。
 */
export const streamEventSubscription = async (
  req: IncomingMessage,
  res: ServerResponse,
  subscription: EventSubscription,
  options: SseStreamOptions,
): Promise<void> => {
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  let resolveClosed: () => void = () => undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (unsubscribe !== undefined) {
      try {
        unsubscribe();
      } catch (error) {
        options.logger?.warn(
          `[dsh-android-gateway] SSE unsubscribe failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      unsubscribe = undefined;
    } else {
      // headers 都还没写成功就失败时，core 的 open() 已在内部登记了订阅者；
      // 这里补一次 subscribe + unsubscribe，确保提前返回也不会留下缓冲订阅。
      try {
        const dispose = subscription.subscribe(() => undefined);
        dispose();
      } catch (error) {
        options.logger?.warn(
          `[dsh-android-gateway] SSE early unsubscribe failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    resolveClosed();
  };

  req.once("close", cleanup);
  req.once("error", cleanup);
  res.once("close", cleanup);
  res.once("error", cleanup);

  const write = (frame: string): boolean => {
    if (closed || res.writableEnded || res.destroyed) return false;
    try {
      res.write(frame);
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  try {
    if (res.writableEnded || res.destroyed) {
      // 客户端在 headers 写出前已断开：不写帧，直接释放订阅。
      return;
    }
    res.writeHead(200, SSE_RESPONSE_HEADERS);
    res.flushHeaders();

    // 契约要求先写 replay（断线续传的权威顺序），再挂实时 listener。
    let replayBroken = false;
    for (const event of subscription.replay) {
      if (!write(encodeSseEventFrame(event))) {
        replayBroken = true;
        break;
      }
    }

    if (!replayBroken && !closed) {
      unsubscribe = subscription.subscribe((event) => {
        if (!write(encodeSseEventFrame(event))) cleanup();
      });
    }

    if (!closed && options.heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        if (!write(SSE_HEARTBEAT_FRAME)) cleanup();
      }, options.heartbeatMs);
      // 不让心跳计时器单独维持进程存活（测试/宿主卸载时很重要）。
      heartbeat.unref();
    }

    await closedPromise;
  } finally {
    cleanup();
    if (!res.writableEnded && !res.destroyed) {
      try {
        res.end();
      } catch {
        // 连接已经断开时忽略。
      }
    }
  }
};
