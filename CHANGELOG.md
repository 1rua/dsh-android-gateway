# 变更记录

## 0.2.0 — 2026-10-21

功能补全：0.1.0 中标记为未实现的能力全部落地，并保持 App 零修改。

### 新增

- 消息批次：`POST /conversations/{id}/message-batches`，1–20 成员、`newline-v1`、
  聚合字节上限、共享 generation、成员独立状态与历史 `batchId`。
- `/new`：在网关内新建 DSH 会话并回发 `conversation.command.result`，源消息保留。
- 斜杠命令执行：App 发送的 `/permission`、`/compact` 等宿主人机命令直接执行，
  输出以 assistant 消息回到时间线；未知命令仍按普通文本交给模型。
- 审批卡片：`approval/request` answerer（优先于 Web UI）→ `conversation.approval.requested`
  / `resolved` + `POST /approvals/{id}/decisions`，只提供 `once`/`deny`，300 秒超时。
- WebSocket 事件传输：`/open-android-intelligence/v2/events/ws`，九 header 签名握手、
  游标重放、实时帧、Ping 心跳、410 游标过期；App 自动优先使用，失败回落 SSE。
- 邀请配对：`POST /sessions/invite/challenge`、`/sessions/invite/exchange`
  （别名 `/pairings/exchange`）、`tools/admin.mjs`（create/list/revoke，短码与深链）。
- 设备密钥登录：`POST /sessions/device/challenge`、`POST /sessions/device`，
  已配对设备 + installation 双重绑定。
- 设备能力：能力发布（JCS Schema 摘要复核、持久化）、请求队列、claim/result/detail、
  `pendingDeviceRequests` 基线快照、两个 Agent 作用域工具
  `open_android_capabilities` / `open_android_device`。
- 历史媒体原件：`cache-grant` 短期授权 + `content` 回读，图片/文件均保存宿主附件引用。
- 错误码映射补齐（配对、审批、幂等、附件等），`tools/` 进入 npm files。

### 验证

- 自动化：`npx tsc --noEmit` 通过；`npx vitest run` **201 用例全通过**。
- 真实 DSH + Android 模拟器：协商 7 项会话 UI / 4 种认证；单成员批次成功并收到回复；
  `/new` 切换新会话；`/permission read-only` 返回 `preset read-only`；审批卡片在
  App 内渲染并进入 300 秒倒计时；`open_android_capabilities` 工具被模型调用并返回
  `available=false`；WebSocket 握手成功且 App 状态为已连接。
- 真实 HTTP：邀请短码完成 challenge/exchange；同一设备用 Ed25519 完成设备密钥登录。
- 详细记录见 `docs/reviews/2026-10-21-feature-completion.md`。

### 已知限制

- 会话镜像（`session-mirror-v1`）未声明，App 自动降级。
- 删除会话为网关墓碑 + 宿主归档（DSH 无公开删除 API）。
- 插件热重载会中断进行中的事件流，App 重启后可从历史恢复。
- 设备能力参数在 Gateway 侧只校验发布 Schema 摘要与 JSON 形状；App 执行前仍按
  发布 Schema 再校验。

## 0.1.0 — 2026-10-20

首个可安装版本：把 Open Android Intelligence App 接入 DeepSeek Harness。

### 新增

- DSH Bundle 宿主插件，复用 `ctx.webServer` 在 `/open-android-intelligence/v2` 提供
  Gateway Protocol v2.1 服务端。
- 协议协商：核心 Schema 摘要校验（`sha256:032f5802…4d23`）、能力交集、limits、
  `gatewayIdentity`。
- 账号与设备：密码登录、refresh 轮换与复用检测、登出、解除配对、每账号 SQLite
  与物理隔离目录、自动生成一次性登录凭据。
- 请求安全：九 header 单例证明、canonical target、Ed25519 验签、时间窗、nonce
  防重放、幂等账本、登出签名豁免。
- 事件流：账号事件日志、SSE 游标续传、心跳、断线重连、`CURSOR_EXPIRED`。
- 对话：列表/创建/读取/改名/归档/删除墓碑、消息发送与状态、历史投影与分页、
  当前生成查询、停止生成、命令目录、会话组织、基线快照。
- 附件：三段式上传、AES-256-GCM 加密暂存、Digest 校验、TTL 清理、图片/文件
  转交 DSH、历史媒体元数据降级。
- 配对状态：`GET /pairings/current`、`POST /pairings/current/capabilities`，
  摘要算法与 App 的 JCS 计算一致。
- 测试：契约向量、存储、核心闭环、HTTP 传输共 107 个用例；真实 DSH + Android
  模拟器端到端验证（见 `docs/reviews/2026-10-20-device-verification.md`）。

### 已知限制

- 未实现：消息批次、会话镜像、审批卡片、邀请配对、设备密钥登录、WebSocket、
  设备能力请求（通知/短信/通话记录）与历史媒体原件流。
- 删除会话为网关墓碑 + 宿主归档（DSH 无公开删除 API）。
- 插件热重载会中断进行中的 SSE 生成流，App 重启后可从历史恢复。
