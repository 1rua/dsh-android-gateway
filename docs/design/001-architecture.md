# DSH Android Gateway 架构设计

- 状态：已接受
- 日期：2026-10-20
- 契约：Open Android Intelligence Gateway Protocol v2.1（提交 `745e2cf` 的 `docs/contracts/gateway-protocol-v2.md`）

## 1. 目标

把 **Open Android Intelligence** Android 客户端接入 **DeepSeek Harness (DSH)**：
手机端继续使用它原有的工作台、会话流、附件、命令目录与设备插件，DSH 作为
「又一个 Agent 宿主」，与 Hermes / OpenClaw 的地位相同。

约束：

1. **不修改 App 仓库**。所有适配在本仓库完成，App 侧零改动。
2. 宿主能力通过协商如实声明：实现了才声明，未实现的能力位绝不声明，让 App
   自动降级，而不是显示一个点了没反应的按钮。
3. 协议层以 App 仓库的 `gateway-contract` 为唯一真源；本仓库只做**只读快照**，
   不复制业务代码，不修改契约。
4. 插件以 DSH Bundle 形式安装进 profile，复用 DSH 自己的 HTTP 端口与 Agent /
   Session 服务，不引入独立守护进程。

## 2. 非目标（v0.1）

- 账号邀请配对、设备密钥会话、WebSocket 事件通道；
- 消息批次（`message-batches-v1`）、会话镜像（`conversation-mirror-v1`）；
- 结构化审批卡片（`agent-approval-cards-v1`）；
- 设备插件能力请求（通知 / 短信 / 通话记录）——后续版本通过 DSH 工具补齐；
- Gateway 自己的多账号管理 Web UI。

上述项不声明对应能力位，App 会按契约降级；见第 9 节。

## 3. 总体结构

```
Android App
   │  HTTPS/HTTP + SSE（Gateway Protocol v2.1）
   ▼
DSH Web HTTP 服务器（复用 ctx.webServer，同一端口）
   │  /open-android-intelligence/v2/*
   ▼
┌──────────────────────────── dsh-android-gateway（本插件）────────────────────────────┐
│ http/            路由、原始 header/body 校验、信封、SSE 长连接                      │
│ protocol/        契约加载、core hash、请求签名、Schema 校验、状态机                 │
│ auth/            账号、设备、配对、access session、refresh 轮换、nonce 防重放        │
│ conversations/   会话映射、消息账本、生成生命周期、历史投影                         │
│ attachments/     三段式上传、加密暂存、发送到 DSH 附件/文件服务                      │
│ events/          账号事件日志（SQLite）+ 实时投递中心 + 游标续传                     │
│ dsh/             DSH 服务桥：sessionController / agents / commands / uploads        │
│ store/           每账号 SQLite（node:sqlite），账号注册表与主密钥                    │
└────────────────────────────────────────────────────────────────────────────────────┘
   │  ctx.sessionController / ctx.agents / ctx.sessionQuery / ctx.commands
   │  ctx.fileUploads / ctx.attachments / ctx.workspaceRegistry / ctx.webServer
   ▼
DSH Session 日志（事件溯源，宿主权威历史）
```

### 3.1 为什么复用 `ctx.webServer`

`dsh-host-webserver` 的 `register({ kind, path, handler })` 把原始
`IncomingMessage` / `ServerResponse` 交给插件，足以完成：

- 逐字节读取 entity-body 并计算 SHA-256（签名与附件摘要的前提）；
- 读取 raw header 列表（契约要求证明 9 个认证 header 各出现恰好一次）；
- 保持 SSE 长连接，并在插件卸载时清理。

这样 App 只需要填写一个地址（例如 `http://192.168.1.10:43535`），不需要额外端口、
反向代理或证书。TLS 由 DSH Web 服务器自身配置决定；明文模式下协商返回
`tlsSpkiSha256: null`，App 会持续显示未加密警告（契约 §3 允许显式 HTTP）。

### 3.2 为什么以 DSH Session 为会话真源

OpenClaw/Hermes 插件把「宿主原生会话」当作真源，Gateway 只保存映射与幂等账本。
DSH 的 Session 是事件溯源日志，并通过 `ctx.sessionController` 暴露
`create / prompt / cancel / rename / page / follow / modelCatalog`。因此本插件同样
只保存映射：

- `conversationId`（App 视角）↔ `dsh_session_id`（DSH Session）；
- 消息账本只在需要「Gateway 自己的消息 ID / 状态 / 幂等」时落库；
- 历史读取优先从 DSH 日志投影，避免两份正文漂移。

## 4. DSH 服务绑定

| DSH 服务 | 用途 | 访问方式 |
|---|---|---|
| `ctx.webServer` | 挂载协议路由、SSE | 硬依赖 `inject: ['webServer']` |
| `ctx.sessionController` | 创建会话、发消息、停止生成、改标题、读历史 | `ctx.get()` 可选 |
| `ctx.sessionQuery` | 读取 Session 日志 / surface / 标题 | `ctx.get()` 可选 |
| `ctx.commands` | 命令目录 | `ctx.get()` 可选 |
| `ctx.agents` | 解析 live Agent（取消、订阅） | `ctx.get()` 可选 |
| `ctx.fileUploads` | 把 App 文件转成 DSH 文件回执 | `ctx.get()` 可选 |
| `ctx.attachments` | 传入图片内容块 | `ctx.get()` 可选 |
| `ctx.workspaceRegistry` | 归档（尽力） | `ctx.get()` 可选 |
| `ctx.agentDefaultModel` | 默认模型选择 | `ctx.get()` 可选 |

事件订阅：

- `ctx.on('session/event', (session, event) => …)`：用户消息、助手最终消息、工具结果、turn 边界；
- `ctx.on('agent/assistant-stream', ({ agent, frame }) => …)`：文本增量；
- `ctx.on('agent/status', …)` / `ctx.on('agent/error', …)`：运行状态与失败。

这些订阅在 `ctx.effect` 中注册，插件卸载时自动清理。

## 5. 数据模型（每账号一个 SQLite）

路径：`$DSH_HOME/dsh-android-gateway/accounts/<accountId>/gateway.db`（目录 0700，
文件 0600）。账号注册表 `$DSH_HOME/dsh-android-gateway/accounts.json` 单独保存
`username → accountId + scrypt(password)`，用于登录解析。契约 §5.1 要求先解析账号
再打开账号库，本设计从结构上满足。

| 表 | 关键列 | 说明 |
|---|---|---|
| `devices` | device_id, installation_id, public_key, display_name, pairing_id, pairing_generation, paired_at | 设备与配对 |
| `refresh_credentials` | hash, device_id, installation_id, created_at, revoked_at | 只存摘要 |
| `access_sessions` | session_id, token_hash, device_id, expires_at, revoked_at | 短期会话 |
| `nonces` | nonce, expires_at | 防重放 |
| `idempotency` | request_id, response_json, created_at | 幂等终态 |
| `events` | seq, event_id, type, payload_json, occurred_at | 账号事件流 |
| `conversations` | conversation_id, client_conversation_id, dsh_session_id, title, archived, deleted, created_at, updated_at | App 会话 |
| `messages` | message_id, conversation_id, client_message_id, sender, text, parts_json, status, revision, error_code, generation_id, dsh_seq, created_at, updated_at | 消息账本 |
| `generations` | generation_id, conversation_id, message_id, state, created_at, ended_at | 生成生命周期 |
| `attachments` | attachment_id, client_attachment_id, filename, media_type, size_bytes, sha256, status, storage_path, dsh_ref, created_at, expires_at | 暂存附件 |
| `organization` | singleton: revision, sort_mode, custom_order_json, folders_json, assignments_json | 会话组织（后续） |

所有写操作在 `BEGIN IMMEDIATE` 事务中完成，事件在事务提交后投递。

## 6. 鉴权与签名

1. 客户端 `POST /negotiate`（无签名）：校验协议主版本、`schemaHashes.core`、
   客户端特性声明；返回双方交集、limits、`gatewayIdentity`。
2. `POST /sessions/password`（无签名）：账号解析 → scrypt 校验 → 绑定设备公钥 →
   创建 access session 与 refresh credential → 返回
   `{accountId, deviceId, sessionId, accessToken, refreshCredential, pairingSummary, pairingGeneration, grantRevision}`。
3. 已认证请求：九个 header 单例校验 → Bearer token 查会话 → 身份 header 逐字节比对
   → 时间窗 → nonce 一次性 → 规范化 target → Ed25519 验签（设备公钥）→ 幂等账本。
4. `POST /sessions/refresh`：原子轮换 access session 与 refresh credential；检测复用
   时撤销该设备全部 refresh credential。
5. `DELETE /sessions/current?revokeRefresh=`：契约 §5.5 的签名豁免路径，仅校验
   Bearer + 五个身份 header（不做时间/nonce/签名）。

规范化 target、签名预像、幂等绑定与状态机全部复用 App 仓库契约快照中的实现
（`contract/src/request-signature.ts`、`state-machines.ts`），保证与手机端逐字节一致。

## 7. 对话与生成生命周期

```
App POST /conversations            → sessionController.create({ sessionId, cwd })
App POST .../messages              → 落库 queued → sessionController.prompt(...)
                                     → generation 创建，返回 accepted + messageId + generationId
DSH turn/start                     → conversation.message.status(delivered)
DSH agent/assistant-stream         → conversation.message.delta（累积 text，revision++）
DSH assistant/message (commit)     → conversation.message.completed（最终 parts）
DSH turn/end                       → 用户消息 status(completed|failed)，生成结束
App POST .../generations/{id}/cancel → sessionController.cancel({ sessionId })
```

- 生成 ID 在 prompt 接受时生成，绑定到用户消息。
- 助手消息在第一次文本增量时分配 `messageId`，同一轮内按 step 边界切分。
- 历史读取：DSH `sessionQuery` 日志投影（user / assistant surface 事件），
  与消息账本按 `dsh_seq` 合并，保证与实时流 ID 一致。
- 失败映射：`AGENT_UNAVAILABLE` / `MODEL_REQUEST_REJECTED` / `ATTACHMENT_READ_FAILED`。

## 8. 附件

三段式上传：`POST /attachments` → `PUT /attachments/{id}/content`（验证
`Content-Length` 与 `Digest: sha-256=<base64>`）→ `POST /attachments/{id}/commit`。

- 暂存字节使用每账号主密钥的 AES-256-GCM 加密落盘（主密钥文件 0600）；
- TTL 到期删除字节并把协议状态置 `expired`；
- 发送消息时：图片类媒体 → base64 内容块；其他文件 → `ctx.fileUploads.uploadStream`
  取得回执；随后与文本一起 `sessionController.prompt`；
- 历史媒体的 metadata / cache-grant / content 端点列入后续版本。

## 9. 能力声明（v0.1）

| 能力 | 是否声明 | 说明 |
|---|---|---|
| `messages: chat-v1` | 是 | 文本 + 附件消息 |
| `attachments: staged-sha256-v1` | 是 | 三段式上传 |
| `events: sse-cursor-v1` | 是 | SSE + 游标续传 |
| `deviceRequests: risk-queue-v1` | 否（暂） | 设备请求队列后续实现 |
| `agent-command-catalog-v1` | 是 | DSH 命令目录 |
| `generation-cancel-v1` | 是 | 停止生成 |
| `newline-v1` | 是 | 文本换行语义 |
| `conversation-management-v1` | 是（归档/重命名/删除墓碑） | 删除为网关墓碑 + 宿主归档，见 §11 |
| `message-batches-v1` | 否 | App 自动降级为逐条发送 |
| `conversation-mirror-v1` | 否 | |
| `agent-approval-cards-v1` | 否 | |
| `agent-command-new-v1` | 否 | App「新建对话」走基础端点 |

## 10. 错误与重试

- 错误信封固定为 `{requestId, correlationId, protocol:'2.1', error:{code,message,retryable,retryAfterSeconds,details}}`；
- 认证失败不泄露账号是否存在；
- 幂等终态在 TTL 与审计窗口内保留；
- 协议层异常统一 `INTERNAL_ERROR`，不把内部堆栈或宿主凭据写进响应。

## 11. 已知偏差与后续工作

1. **会话删除**：DSH 没有公开的 Session 删除 API。v0.1 的删除 = 停止生成 + 宿主归档
   （尽力）+ 网关墓碑；DSH Web UI 仍可能在归档区看到该会话。后续可评估接入宿主删除能力。
2. **历史媒体端点**：`metadata / cache-grant / content` 未实现，App 对历史附件会退化为
   仅显示元数据；新发送的附件正常。
3. **设备能力**：通知/短信/通话记录尚未接入，Agent 看不到 `open_android_*` 工具；
   后续版本增加 DSH 工具与设备请求队列。
4. **审批卡片**：未声明，危险命令只能在 DSH Web UI 审批。
5. **WebSocket**：仅实现 SSE；App 会优先尝试 WS 并自动降级（契约允许）。
6. **热重载**：插件热重载会丢失进程内的生成状态与旧 SSE 订阅；进行中的流式回复
   不会继续推送，App 重启后从 DSH 历史恢复。

## 12. 验证计划

1. 契约向量：`contract/vectors/*.json` 的 `request.target`、`request.signature`、
   `schema.validate`、状态机与排队期限全部通过；
2. 单元：账号/refresh 轮换/幂等/事件游标/附件摘要；
3. HTTP 集成：假宿主桥接 + 真实 `node:http`，跑通「协商 → 登录 → 建会话 → 发消息 →
   SSE 增量 → 完成 → 历史 → 取消 → 附件」；
4. DSH 实机：安装 Bundle → 用真实 core hash 协商 → 登录 → 发送一条消息并观察 DSH
   Agent 真实回复 → SSE 收到增量与完成；
5. Android：如环境有模拟器/真机，安装现有 APK 连接本机 DSH 验证；否则如实记录未验证。
