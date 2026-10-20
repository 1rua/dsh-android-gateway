/**
 * DSH 宿主服务的最小结构化类型。
 *
 * 插件运行在 DSH 进程内，运行时由 `ctx.get(name)` 取得服务；这里只声明本插件
 * 实际调用的成员，避免把插件耦合到某个 DSH 版本的完整类型包。版本适配集中在
 * `DshBridge` 一处，服务缺失时 fail-closed。
 */

export interface DshLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
}

export interface DshEventApi {
  on(event: string, listener: (...args: unknown[]) => void): () => void;
}

export interface DshContext {
  get(name: string): unknown;
  on(event: string, listener: (...args: unknown[]) => void): () => void;
  effect(setup: () => (() => void | Promise<void>) | void, name?: string): void;
  logger?: DshLogger;
}

/** `agent/assistant-stream` 的帧（dsh-agent runtime-types）。 */
export type DshAssistantStreamFrame =
  | {
      readonly type: "start";
      readonly attemptId: string;
      readonly revision: number;
      readonly turn: number;
      readonly step: number;
    }
  | {
      readonly type: "chunk";
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly time: number;
      readonly chunk: DshStreamChunk;
    }
  | {
      readonly type: "end";
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly outcome: { readonly kind: "committed" | "abandoned"; readonly seq?: number };
    };

export type DshStreamChunk =
  | { readonly type: "block-start"; readonly index: number; readonly blockType: string }
  | { readonly type: "text-delta"; readonly index: number; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly index: number; readonly text: string }
  | {
      readonly type: "tool-call-delta";
      readonly index: number;
      readonly id: string;
      readonly name?: string;
      readonly argumentsDelta: string;
    }
  | { readonly type: "block-end"; readonly index: number; readonly block: DshContentBlock }
  | { readonly type: "usage"; readonly usage: Record<string, number> }
  | { readonly type: "finish"; readonly reason: { readonly kind: string } };

export type DshContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "image";
      readonly attachment: {
        readonly attachmentId: string;
        readonly mediaType: string;
        readonly bytes: number;
        readonly name?: string;
      };
    }
  | {
      readonly type: "file";
      readonly attachment: { readonly attachmentId: string; readonly name: string; readonly bytes: number };
    }
  | { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly arguments: string };

export interface DshMessage {
  readonly id: string;
  readonly role: "system" | "developer" | "user" | "assistant" | "tool";
  readonly content: readonly DshContentBlock[];
  readonly source?: { readonly kind?: string };
  readonly isError?: boolean;
}

export interface DshSessionEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: Record<string, unknown>;
}

export interface DshSessionHeader {
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
}

export interface DshSurfaceSnapshot {
  readonly session: DshSessionHeader;
  readonly events: readonly DshSessionEvent[];
}

export interface DshSessionController {
  create(request: {
    readonly sessionId?: string;
    readonly cwd?: string;
    readonly workspaceId?: string;
    readonly agentPreset?: string;
  }): Promise<{ readonly sessionId: string; readonly agentPreset?: string }>;
  prompt(
    request: {
      readonly requestId: string;
      readonly sessionId: string;
      readonly mode: "queue" | "steer";
      readonly content: readonly DshPromptPart[];
      readonly clientTimeZone?: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly accepted: true }>;
  cancel(request: { readonly sessionId: string }): { readonly accepted: true };
  rename(request: { readonly sessionId: string; readonly title: string }): Promise<{
    readonly title: string;
    readonly seq: number;
  }>;
  resolveAgent(sessionId: string): Promise<{ readonly agent?: unknown; readonly error?: unknown }>;
  modelCatalog?(): Promise<unknown>;
}

export type DshPromptPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mediaType: string; readonly data: string; readonly name?: string }
  | { readonly type: "file"; readonly receiptId: string };

export interface DshSessionQuery {
  readSurface(sessionId: string): Promise<DshSurfaceSnapshot>;
  readTitle(
    sessionId: string,
  ): Promise<{ readonly title: string; readonly updatedAt: number } | undefined>;
}

export interface DshCommandDescriptor {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string; readonly attachments?: boolean };
}

export interface DshCommands {
  list(agent: unknown): readonly DshCommandDescriptor[];
}

export interface DshFileUploads {
  uploadStream(request: {
    readonly sessionId: string;
    readonly data: AsyncIterable<Uint8Array>;
    readonly signal?: AbortSignal;
    readonly name?: string;
  }): Promise<{ readonly receiptId: string; readonly file: { readonly attachmentId: string } }>;
}

export interface DshWorkspaceRegistry {
  archiveSession(sessionId: string): Promise<void>;
  unarchiveSession(sessionId: string): Promise<void>;
}

export interface DshAgentLike {
  readonly id: string;
  readonly session: { readonly id: string };
}

export interface DshWebRoute {
  readonly kind: "exact" | "prefix";
  readonly path: string;
  readonly handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void | Promise<void>;
}

export interface DshWebServer {
  register(route: DshWebRoute): () => void;
  getOrigin(): string;
}
