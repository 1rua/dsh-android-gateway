import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AccountManager } from "./accounts.js";

export interface BatchMember {
  readonly clientMessageId: string;
  readonly messageId: string;
}

export interface BatchRecord {
  readonly batchId: string;
  readonly conversationId: string;
  readonly clientBatchId: string;
  readonly generationId: string;
  readonly members: readonly BatchMember[];
  readonly response: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

interface BatchFile {
  readonly version: 1;
  readonly batches: BatchRecord[];
}

const MAX_BATCHES = 500;

/**
 * 消息批次的幂等账本。
 *
 * 契约没有给批次定义持久化形状，但重试必须回到同一个 batchId/成员映射；
 * 这里用每账号 0600 JSON 原子文件保存最近 500 个批次（正文不落这里，
 * 正文在消息账本中）。
 */
export class BatchStore {
  readonly #accounts: AccountManager;
  readonly #cache = new Map<string, BatchRecord[]>();

  constructor(accounts: AccountManager) {
    this.#accounts = accounts;
  }

  #path(accountId: string): string {
    return join(this.#accounts.accountDir(accountId), "message-batches.json");
  }

  #load(accountId: string): BatchRecord[] {
    const cached = this.#cache.get(accountId);
    if (cached !== undefined) return cached;
    const path = this.#path(accountId);
    if (!existsSync(path)) {
      const empty: BatchRecord[] = [];
      this.#cache.set(accountId, empty);
      return empty;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BatchFile>;
      const batches = Array.isArray(parsed.batches) ? (parsed.batches as BatchRecord[]) : [];
      this.#cache.set(accountId, batches);
      return batches;
    } catch {
      const empty: BatchRecord[] = [];
      this.#cache.set(accountId, empty);
      return empty;
    }
  }

  #save(accountId: string, batches: BatchRecord[]): void {
    const path = this.#path(accountId);
    const dir = join(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    const file: BatchFile = { version: 1, batches: batches.slice(-MAX_BATCHES) };
    writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    this.#cache.set(accountId, file.batches);
  }

  findByClientBatchId(accountId: string, conversationId: string, clientBatchId: string): BatchRecord | undefined {
    return this.#load(accountId).find(
      (batch) => batch.conversationId === conversationId && batch.clientBatchId === clientBatchId,
    );
  }

  findByGeneration(accountId: string, generationId: string): BatchRecord | undefined {
    return this.#load(accountId).find((batch) => batch.generationId === generationId);
  }

  /** conversationId → messageId → batchId，用于历史时间线补充 `batchId`。 */
  batchIdsForConversation(accountId: string, conversationId: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const batch of this.#load(accountId)) {
      if (batch.conversationId !== conversationId) continue;
      for (const member of batch.members) map.set(member.messageId, batch.batchId);
    }
    return map;
  }

  put(accountId: string, record: BatchRecord): void {
    const batches = [...this.#load(accountId).filter((batch) => batch.batchId !== record.batchId), record];
    this.#save(accountId, batches);
  }
}
