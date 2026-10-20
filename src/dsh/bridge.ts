import type {
  DshAttachments,
  DshFileRef,
  DshImageRef,
  DshAssistantStreamFrame,
  DshCommandDescriptor,
  DshCommands,
  DshContentBlock,
  DshContext,
  DshFileUploads,
  DshLogger,
  DshSessionController,
  DshSessionEvent,
  DshSessionQuery,
  DshWorkspaceRegistry,
} from "./types.js";

/** 桥接层向业务层冒泡的 DSH 事实。 */
export type DshBridgeEvent =
  | { readonly kind: "session"; readonly sessionId: string; readonly event: DshSessionEvent }
  | { readonly kind: "stream"; readonly sessionId: string; readonly frame: DshAssistantStreamFrame }
  | { readonly kind: "status"; readonly sessionId: string; readonly status: string }
  | { readonly kind: "error"; readonly sessionId: string; readonly error: unknown };

export interface DshBridgeOptions {
  /** 新会话使用的默认工作目录；缺省用 DSH 当前工作目录。 */
  readonly workspace?: string;
  /** 新会话使用的 Agent 预设。 */
  readonly agentPreset?: string;
}

type Listener = (event: DshBridgeEvent) => void;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * DSH 宿主服务桥。
 *
 * 只负责「找到服务、调用服务、转发事件」；会话与消息的网关语义在 core 层。
 * 必需服务缺失时 `availability.available=false`，插件应以 HOST_INCOMPATIBLE
 * 失败关闭，而不是假装已连接。
 */
export class DshBridge {
  readonly #ctx: DshContext;
  readonly #options: DshBridgeOptions;
  readonly #listeners = new Set<Listener>();
  readonly #disposers: Array<() => void> = [];
  readonly #logger?: DshLogger;

  constructor(ctx: DshContext, options: DshBridgeOptions = {}) {
    this.#ctx = ctx;
    this.#options = options;
    const logger = ctx.logger;
    this.#logger = logger;
    this.#disposers.push(
      ctx.on("session/event", (...args) => {
        const session = args[0] as { readonly id?: unknown } | undefined;
        const event = args[1] as DshSessionEvent | undefined;
        const sessionId = asString(session?.id);
        if (sessionId === undefined || event === undefined) return;
        this.#emit({ kind: "session", sessionId, event });
      }),
      ctx.on("agent/assistant-stream", (...args) => {
        const payload = args[0] as
          | { readonly agent?: { readonly session?: { readonly id?: unknown } }; readonly frame?: unknown }
          | undefined;
        const sessionId = asString(payload?.agent?.session?.id);
        if (sessionId === undefined || payload?.frame === undefined) return;
        this.#emit({
          kind: "stream",
          sessionId,
          frame: payload.frame as DshAssistantStreamFrame,
        });
      }),
      ctx.on("agent/status", (...args) => {
        const payload = args[0] as
          | { readonly agent?: { readonly session?: { readonly id?: unknown } }; readonly status?: unknown }
          | undefined;
        const sessionId = asString(payload?.agent?.session?.id);
        const status = asString(payload?.status);
        if (sessionId === undefined || status === undefined) return;
        this.#emit({ kind: "status", sessionId, status });
      }),
      ctx.on("agent/error", (...args) => {
        const payload = args[0] as
          | { readonly agent?: { readonly session?: { readonly id?: unknown } }; readonly error?: unknown }
          | undefined;
        const sessionId = asString(payload?.agent?.session?.id);
        if (sessionId === undefined) return;
        this.#emit({ kind: "error", sessionId, error: payload?.error });
      }),
    );
  }

  get logger(): DshLogger | undefined {
    return this.#logger;
  }

  #service<T>(name: string): T | undefined {
    const value = this.#ctx.get(name);
    return value === undefined || value === null ? undefined : (value as T);
  }

  get sessionController(): DshSessionController | undefined {
    return this.#service<DshSessionController>("sessionController");
  }

  get sessionQuery(): DshSessionQuery | undefined {
    return this.#service<DshSessionQuery>("sessionQuery");
  }

  get commands(): DshCommands | undefined {
    return this.#service<DshCommands>("commands");
  }

  get fileUploads(): DshFileUploads | undefined {
    return this.#service<DshFileUploads>("fileUploads");
  }

  get workspaceRegistry(): DshWorkspaceRegistry | undefined {
    return this.#service<DshWorkspaceRegistry>("workspaceRegistry");
  }

  get attachments(): DshAttachments | undefined {
    return this.#service<DshAttachments>("attachments");
  }

  /** 先把图片落到宿主附件库，取得可回读的持久引用（历史媒体用）。 */
  async saveImage(
    bytes: Uint8Array,
    mediaType: string,
    name?: string,
  ): Promise<DshImageRef | undefined> {
    const store = this.attachments;
    if (store === undefined) return undefined;
    const refs = await store.saveImages([
      { data: bytes, mediaType, ...(name === undefined ? {} : { name }) },
    ]);
    return refs[0];
  }

  async readImage(ref: DshImageRef): Promise<Uint8Array | undefined> {
    const store = this.attachments;
    if (store === undefined) return undefined;
    try {
      return (await store.readImage(ref)).data;
    } catch {
      return undefined;
    }
  }

  async *readFile(ref: DshFileRef, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const store = this.attachments;
    if (store === undefined) return;
    for await (const chunk of store.readFileStream(ref, signal)) yield chunk;
  }

  get availability(): { readonly available: boolean; readonly missing: readonly string[] } {
    const missing: string[] = [];
    if (this.sessionController === undefined) missing.push("sessionController");
    if (this.sessionQuery === undefined) missing.push("sessionQuery");
    return { available: missing.length === 0, missing };
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(event: DshBridgeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#logger?.warn?.(
          `[dsh-android-gateway] bridge listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** 创建（或复用空白）DSH Session；返回宿主实际使用的 Session ID。 */
  async createSession(input: {
    readonly sessionId: string;
    readonly cwd?: string;
  }): Promise<string> {
    const controller = this.sessionController;
    if (controller === undefined) throw new Error("HOST_INCOMPATIBLE:sessionController");
    const result = await controller.create({
      sessionId: input.sessionId,
      ...(input.cwd ?? this.#options.workspace
        ? { cwd: input.cwd ?? this.#options.workspace }
        : {}),
      ...(this.#options.agentPreset === undefined
        ? {}
        : { agentPreset: this.#options.agentPreset }),
    });
    return result.sessionId;
  }

  /** 入队一条用户输入（冷会话会自动恢复 Agent）。 */
  async prompt(input: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly content: readonly import("./types.js").DshPromptPart[];
  }): Promise<void> {
    const controller = this.sessionController;
    if (controller === undefined) throw new Error("HOST_INCOMPATIBLE:sessionController");
    const abort = new AbortController();
    await controller.prompt(
      {
        requestId: input.requestId,
        sessionId: input.sessionId,
        mode: "queue",
        content: input.content,
      },
      abort.signal,
    );
  }

  /** 请求取消当前 turn；返回宿主是否接受。 */
  cancel(sessionId: string): boolean {
    const controller = this.sessionController;
    if (controller === undefined) return false;
    try {
      return controller.cancel({ sessionId }).accepted === true;
    } catch (error) {
      this.#logger?.warn?.(
        `[dsh-android-gateway] cancel failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** 改会话标题（DSH 日志权威）。 */
  async rename(sessionId: string, title: string): Promise<string> {
    const controller = this.sessionController;
    if (controller === undefined) throw new Error("HOST_INCOMPATIBLE:sessionController");
    const result = await controller.rename({ sessionId, title });
    return result.title;
  }

  /** 读取完整 surface 快照（历史投影用）。 */
  async readSurface(sessionId: string): Promise<{ readonly events: readonly DshSessionEvent[] } | undefined> {
    const query = this.sessionQuery;
    if (query === undefined) return undefined;
    try {
      const snapshot = await query.readSurface(sessionId);
      return { events: snapshot.events };
    } catch (error) {
      this.#logger?.warn?.(
        `[dsh-android-gateway] readSurface failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  async readTitle(sessionId: string): Promise<string | undefined> {
    const query = this.sessionQuery;
    if (query === undefined) return undefined;
    try {
      const title = await query.readTitle(sessionId);
      return title?.title;
    } catch {
      return undefined;
    }
  }

  /** 解析/恢复会话对应的 Agent；失败返回 undefined（命令与工具作用域用）。 */
  async resolveAgent(sessionId: string): Promise<{ readonly agent?: unknown } | undefined> {
    const controller = this.sessionController;
    if (controller === undefined) return undefined;
    try {
      return (await controller.resolveAgent(sessionId)) as { readonly agent?: unknown };
    } catch (error) {
      this.#logger?.warn?.(
        `[dsh-android-gateway] resolveAgent failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  /** 执行一条宿主人类命令；未知命令返回 undefined，由调用方按普通文本处理。 */
  async executeCommand(
    sessionId: string,
    line: string,
  ): Promise<{ readonly result: { readonly kind: "success" | "error"; readonly text?: string } } | undefined> {
    const commands = this.commands;
    const controller = this.sessionController;
    if (commands === undefined || controller === undefined) return undefined;
    try {
      const resolved = await controller.resolveAgent(sessionId);
      if (resolved.agent === undefined) return undefined;
      const execution = await commands.execute(
        resolved.agent,
        line,
        [],
        new AbortController().signal,
      );
      return execution === undefined ? undefined : { result: execution.result };
    } catch (error) {
      this.#logger?.warn?.(
        `[dsh-android-gateway] command execution failed for ${line.slice(0, 40)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  /** 命令目录：需要会话对应的 Agent（会恢复冷会话）。 */
  async listCommands(sessionId: string): Promise<readonly DshCommandDescriptor[]> {
    const controller = this.sessionController;
    const commands = this.commands;
    if (controller === undefined || commands === undefined) return [];
    try {
      const resolved = await controller.resolveAgent(sessionId);
      if (resolved.agent === undefined) return [];
      return commands.list(resolved.agent);
    } catch (error) {
      this.#logger?.warn?.(
        `[dsh-android-gateway] listCommands failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /** 把附件字节写入 DSH 文件上传暂存并取得回执。 */
  async uploadFile(
    sessionId: string,
    data: AsyncIterable<Uint8Array>,
    name: string,
  ): Promise<{ readonly receiptId: string; readonly attachmentId: string } | undefined> {
    const uploads = this.fileUploads;
    if (uploads === undefined) return undefined;
    const value = await uploads.uploadStream({ sessionId, data, name });
    return { receiptId: value.receiptId, attachmentId: value.file.attachmentId };
  }

  /** 尽力归档/恢复宿主会话；失败不阻断网关状态。 */
  async setArchived(sessionId: string, archived: boolean): Promise<boolean> {
    const registry = this.workspaceRegistry;
    if (registry === undefined) return false;
    try {
      if (archived) await registry.archiveSession(sessionId);
      else await registry.unarchiveSession(sessionId);
      return true;
    } catch (error) {
      this.#logger?.warn?.(
        `[dsh-android-gateway] archive(${archived}) failed for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  dispose(): void {
    while (this.#disposers.length > 0) {
      try {
        this.#disposers.pop()?.();
      } catch {
        // 卸载路径上的监听器失败不影响其他清理。
      }
    }
    this.#listeners.clear();
  }
}

/** 从 DSH 内容块提取纯文本（忽略 reasoning 与工具调用）。 */
export const textOfBlocks = (blocks: readonly DshContentBlock[]): string =>
  blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
