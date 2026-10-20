import { randomBytes } from "node:crypto";

import { GatewayError } from "../shared/errors.js";
import { nowIso } from "../shared/ids.js";
import type { AccountStore, AppendEventInput } from "../store/contract.js";
import type { EventSubscription, EventStreamService } from "../http/contract.js";
import type { EventRecord } from "../shared/types.js";

/** 契约 §9：游标过旧时返回可安全重建的资源类型。 */
export interface CursorExpiredDetails {
  readonly recoverableResources: readonly ["conversations", "attachments", "device-requests"];
}

const CURSOR_PREFIX = "evt";

interface Subscriber {
  listener: (event: EventRecord) => void;
}

interface AccountHub {
  readonly subscribers: Set<Subscriber>;
  /** 串行化 publish/open，保证「先订阅、再重放」不漏事件也不重复。 */
  chain: Promise<unknown>;
  lastPruneAt: number;
}

export interface EventHubOptions {
  readonly openStore: (accountId: string) => AccountStore | undefined;
  readonly retentionSeconds: number;
  readonly logger?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  readonly now?: () => number;
}

/**
 * 账号事件流：持久化到账号库 + 进程内实时投递。
 *
 * 事件 ID 即恢复游标。`open` 在没有游标时从当前头部之后开始（只接收新事件），
 * 有游标时从该事件之后重放；游标已裁剪返回 CURSOR_EXPIRED。
 */
export class GatewayEventHub implements EventStreamService {
  readonly #options: EventHubOptions;
  readonly #hubs = new Map<string, AccountHub>();
  readonly #now: () => number;

  constructor(options: EventHubOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  #hub(accountId: string): AccountHub {
    let hub = this.#hubs.get(accountId);
    if (hub === undefined) {
      hub = { subscribers: new Set(), chain: Promise.resolve(), lastPruneAt: 0 };
      this.#hubs.set(accountId, hub);
    }
    return hub;
  }

  #serialize<T>(accountId: string, task: () => Promise<T>): Promise<T> {
    const hub = this.#hub(accountId);
    const run = hub.chain.then(task, task);
    hub.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 追加一条账号事件并立即投递给所有在线订阅者。
   * 调用方必须在业务状态提交后调用；本方法不再回滚业务写入。
   */
  async publish(
    accountId: string,
    input: Omit<AppendEventInput, "eventId" | "occurredAt"> & {
      readonly occurredAt?: string;
      readonly requestId?: string;
    },
  ): Promise<EventRecord> {
    return this.#serialize(accountId, async () => {
      const store = this.#options.openStore(accountId);
      if (store === undefined) {
        throw new GatewayError("ACCOUNT_NOT_FOUND", "Unknown account");
      }
      const eventId = this.#nextEventId(store);
      const record = store.appendEvent({
        eventId,
        type: input.type,
        payload: input.payload,
        correlationId: input.correlationId,
        occurredAt: input.occurredAt ?? nowIso(),
      });
      const hub = this.#hub(accountId);
      for (const subscriber of [...hub.subscribers]) {
        try {
          subscriber.listener(record);
        } catch (error) {
          this.#options.logger?.warn(
            `[dsh-android-gateway] event subscriber failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      this.#pruneIfDue(accountId, store);
      return record;
    });
  }

  async open(accountId: string, cursor: string | null): Promise<EventSubscription> {
    return this.#serialize(accountId, async () => {
      const store = this.#options.openStore(accountId);
      if (store === undefined) {
        throw new GatewayError("ACCOUNT_NOT_FOUND", "Unknown account");
      }
      const hub = this.#hub(accountId);
      const buffered: EventRecord[] = [];
      const subscriber: Subscriber = {
        listener: (event) => {
          buffered.push(event);
        },
      };
      hub.subscribers.add(subscriber);

      let replay: readonly EventRecord[] = [];
      if (cursor !== null) {
        const anchor = store.findEventByEventId(cursor);
        if (anchor === undefined) {
          hub.subscribers.delete(subscriber);
          await this.#pruneIfDue(accountId, store, true);
          throw new GatewayError(
            "CURSOR_EXPIRED",
            "The event cursor is older than the retention window",
            {
              details: {
                recoverableResources: ["conversations", "attachments", "device-requests"],
              },
            },
          );
        }
        replay = store.listEventsAfter(anchor.seq, 500);
      } else {
        // 无游标表示「从现在开始」：不重放历史，只看新事件。
        const head = store.latestEventSeq();
        replay = [];
        // 记录头部，便于测试与日志。
        void head;
      }

      const replayedIds = new Set(replay.map((event) => event.eventId));
      const subscription: EventSubscription = {
        replay,
        subscribe(listener) {
          subscriber.listener = listener;
          buffered.splice(0).forEach((event) => {
            if (replayedIds.has(event.eventId)) return;
            listener(event);
          });
          return () => {
            hub.subscribers.delete(subscriber);
          };
        },
      };
      return subscription;
    });
  }

  /** 关闭某个账号的全部在线订阅，用于账号解绑/删号。 */
  closeAccount(accountId: string): void {
    const hub = this.#hubs.get(accountId);
    if (hub === undefined) return;
    hub.subscribers.clear();
    this.#hubs.delete(accountId);
  }

  #nextEventId(store: AccountStore): string {
    // 事件 ID 必须满足 wire ID；用 seq 派生，保证单调且可读。
    const seq = store.latestEventSeq() + 1;
    return `${CURSOR_PREFIX}_${seq.toString(36)}${randomBytes(3).toString("hex")}`;
  }

  #pruneIfDue(accountId: string, store: AccountStore, force = false): void {
    const hub = this.#hub(accountId);
    const now = this.#now();
    if (!force && now - hub.lastPruneAt < 60_000) return;
    hub.lastPruneAt = now;
    const cutoff = new Date(now - this.#options.retentionSeconds * 1000).toISOString();
    try {
      store.pruneEvents(cutoff);
    } catch (error) {
      this.#options.logger?.warn(
        `[dsh-android-gateway] event prune failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** 事件信封的 SSE data 形状（契约 §9）。 */
export const sseDataJson = (event: EventRecord): string =>
  JSON.stringify({
    correlationId: event.correlationId,
    occurredAt: event.occurredAt,
    payload: event.payload,
  });
