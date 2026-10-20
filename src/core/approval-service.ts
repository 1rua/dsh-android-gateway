import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { GatewayError } from "../shared/errors.js";
import { createWireId, nowIso } from "../shared/ids.js";
import type { JsonObject, VerifiedRequest } from "../shared/types.js";
import type { AccountManager } from "./accounts.js";
import type { GatewayEventHub } from "./event-hub.js";

const APPROVAL_TIMEOUT_SECONDS = 300;

export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";
export type ApprovalDecision = "once" | "session" | "always" | "deny";
export type ApprovalTerminal = ApprovalDecision | "timeout" | "withdrawn";

export interface DshApprovalRequest {
  readonly agent: { readonly session: { readonly id: string } };
  readonly toolName: string;
  readonly reason?: string;
  readonly displayReason?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

interface PersistedApproval {
  readonly approvalId: string;
  readonly conversationId: string;
  readonly decision: ApprovalTerminal;
  readonly decidedAt: number;
}

interface PendingApproval {
  readonly approvalId: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly command: string;
  readonly reason: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
  options: readonly { readonly choice: ApprovalDecision; readonly style: string }[];
  settle: ((outcome: ApprovalOutcome) => void) | undefined;
  settledDecision: ApprovalTerminal | undefined;
  timer: NodeJS.Timeout | undefined;
  signalCleanup: (() => void) | undefined;
}

export interface ApprovalServiceOptions {
  readonly accounts: AccountManager;
  readonly events: GatewayEventHub;
  readonly findConversation: (
    sessionId: string,
  ) => { readonly accountId: string; readonly conversationId: string } | undefined;
  readonly logger?: { info(message: string): void; warn(message: string): void; error(message: string): void };
  readonly now?: () => number;
}

/**
 * 审批卡片（契约 §7.2）。
 *
 * DSH 的审批结果闭集只有 `allowed-once | rejected | cancelled | unavailable`，
 * 因此卡片只下发 `once` 与 `deny` 两档（契约允许宿主按实际能力下发子集）。
 * `approvalId` 是唯一交互句柄，宿主会话 ID 不出现在事件里。
 */
export class ApprovalService {
  readonly #options: ApprovalServiceOptions;
  readonly #pending = new Map<string, PendingApproval>();
  readonly #persisted = new Map<string, Map<string, PersistedApproval>>();
  readonly #now: () => number;

  constructor(options: ApprovalServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  #file(accountId: string): string {
    return join(this.#options.accounts.accountDir(accountId), "approvals.json");
  }

  #load(accountId: string): Map<string, PersistedApproval> {
    const cached = this.#persisted.get(accountId);
    if (cached !== undefined) return cached;
    const map = new Map<string, PersistedApproval>();
    const path = this.#file(accountId);
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { approvals?: PersistedApproval[] };
        for (const record of parsed.approvals ?? []) map.set(record.approvalId, record);
      }
    } catch {
      // 损坏记录按空处理；审批记录不是安全凭据。
    }
    this.#persisted.set(accountId, map);
    return map;
  }

  #save(accountId: string, map: Map<string, PersistedApproval>): void {
    const path = this.#file(accountId);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const records = [...map.values()].slice(-200);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ approvals: records })}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    this.#persisted.set(accountId, new Map(records.map((record) => [record.approvalId, record])));
  }

  /** 作为 `approval/request` answerer 注册；非网关会话交还下一个 answerer。 */
  async handle(request: DshApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const conversation = this.#options.findConversation(request.agent.session.id);
    if (conversation === undefined) return next();
    const account = this.#options.accounts.findAccount(conversation.accountId);
    if (account === undefined) return "unavailable";
    const now = this.#now();
    const approvalId = createWireId("apr_");
    const command = request.displayReason?.zh ?? request.displayReason?.en ?? request.toolName;
    const reason = request.reason ?? request.displayReason?.zh ?? request.displayReason?.en ?? request.toolName;
    const pending: PendingApproval = {
      approvalId,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      command,
      reason,
      requestedAt: now,
      expiresAt: now + APPROVAL_TIMEOUT_SECONDS * 1000,
      options: [
        { choice: "once", style: "primary" },
        { choice: "deny", style: "danger" },
      ],
      settle: undefined,
      settledDecision: undefined,
      timer: undefined,
      signalCleanup: undefined,
    };
    this.#pending.set(approvalId, pending);
    await this.#emit(conversation.accountId, "conversation.approval.requested", {
      approvalId,
      conversationId: conversation.conversationId,
      command,
      reason,
      severity: "elevated",
      options: pending.options as unknown as import("../shared/types.js").JsonValue,
      timeoutSeconds: APPROVAL_TIMEOUT_SECONDS,
      requestedAt: now,
      expiresAt: pending.expiresAt,
    }, approvalId);

    const outcome = await new Promise<ApprovalOutcome>((resolve) => {
      let done = false;
      const finish = (value: ApprovalOutcome, decision: ApprovalTerminal): void => {
        if (done) return;
        done = true;
        pending.settledDecision = decision;
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        pending.signalCleanup?.();
        this.#persistDecision(pending.accountId, {
          approvalId,
          conversationId: conversation.conversationId,
          decision,
          decidedAt: this.#now(),
        });
        resolve(value);
      };
      pending.settle = (value) => {
        const decision: ApprovalTerminal = value === "allowed-once" ? "once" : value === "cancelled" ? "withdrawn" : "deny";
        finish(value, decision);
      };
      pending.timer = setTimeout(() => {
        void this.#emit(conversation.accountId, "conversation.approval.resolved", {
          approvalId,
          conversationId: conversation.conversationId,
          decision: "timeout",
          decidedAt: pending.expiresAt,
        }, approvalId).catch(() => undefined);
        finish("rejected", "timeout");
      }, APPROVAL_TIMEOUT_SECONDS * 1000);
      pending.timer.unref?.();
      if (request.signal !== undefined) {
        const onAbort = (): void => {
          void this.#emit(conversation.accountId, "conversation.approval.resolved", {
            approvalId,
            conversationId: conversation.conversationId,
            decision: "withdrawn",
            decidedAt: this.#now(),
          }, approvalId).catch(() => undefined);
          finish("cancelled", "withdrawn");
        };
        if (request.signal.aborted) onAbort();
        else {
          request.signal.addEventListener("abort", onAbort, { once: true });
          pending.signalCleanup = () => request.signal?.removeEventListener("abort", onAbort);
        }
      }
    });
    this.#pending.delete(approvalId);
    return outcome;
  }

  /** POST /approvals/{approvalId}/decisions */
  async decide(
    request: VerifiedRequest,
    approvalId: string,
    body: JsonObject | null,
  ): Promise<JsonObject> {
    const decision = body?.decision;
    if (decision !== "once" && decision !== "session" && decision !== "always" && decision !== "deny") {
      throw new GatewayError("APPROVAL_DECISION_INVALID", "Unknown approval decision");
    }
    const pending = this.#pending.get(approvalId);
    const persisted = this.#load(request.accountId).get(approvalId);
    if (pending === undefined && persisted === undefined) {
      throw new GatewayError("APPROVAL_NOT_FOUND", "Unknown approval", { httpStatus: 404 });
    }
    if (pending === undefined && persisted !== undefined) {
      // 宿主已经不再等待该审批：按契约结算为 withdrawn，绝不把用户按键记成允许。
      if (persisted.decision === "withdrawn" || persisted.decision === "timeout") {
        throw new GatewayError("APPROVAL_ALREADY_RESOLVED", "Approval is already resolved", {
          httpStatus: 409,
          details: { decision: persisted.decision },
        });
      }
      throw new GatewayError("APPROVAL_ALREADY_RESOLVED", "Approval is already resolved", {
        httpStatus: 409,
        details: { decision: persisted.decision },
      });
    }
    const target = pending!;
    if (target.accountId !== request.accountId) {
      throw new GatewayError("APPROVAL_NOT_FOUND", "Unknown approval", { httpStatus: 404 });
    }
    if (target.settledDecision !== undefined) {
      const same = target.settledDecision === decision;
      throw new GatewayError("APPROVAL_ALREADY_RESOLVED", "Approval is already resolved", {
        httpStatus: 409,
        details: { decision: target.settledDecision, sameDecision: same },
      });
    }
    if ((decision === "session" || decision === "always") && !target.options.some((option) => option.choice === decision)) {
      throw new GatewayError("APPROVAL_DECISION_INVALID", "This host only supports once or deny");
    }
    const decidedAt = this.#now();
    const outcome: ApprovalOutcome = decision === "deny" ? "rejected" : "allowed-once";
    target.settledDecision = decision;
    this.#persistDecision(request.accountId, {
      approvalId,
      conversationId: target.conversationId,
      decision,
      decidedAt,
    });
    await this.#emit(request.accountId, "conversation.approval.resolved", {
      approvalId,
      conversationId: target.conversationId,
      decision,
      decidedAt,
    }, request.requestId);
    const settle = target.settle;
    target.settle = undefined;
    settle?.(outcome);
    return {
      approval: {
        approvalId,
        conversationId: target.conversationId,
        decision,
        decidedAt,
      },
    };
  }

  #persistDecision(accountId: string, record: PersistedApproval): void {
    const map = this.#load(accountId);
    map.set(record.approvalId, record);
    try {
      this.#save(accountId, map);
    } catch (error) {
      this.#options.logger?.warn(
        `[dsh-android-gateway] approval persistence failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async #emit(
    accountId: string,
    type: string,
    payload: JsonObject,
    correlationId: string,
  ): Promise<void> {
    await this.#options.events.publish(accountId, { type, payload, correlationId });
  }

  /** 插件卸载：所有仍在等待的审批结算为 withdrawn（工具失败关闭）。 */
  dispose(): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.signalCleanup?.();
      pending.settle?.("cancelled");
    }
    this.#pending.clear();
  }
}

export const approvalTimestamp = (value: number): string => nowIso(new Date(value));
