# 变更记录

## 0.3.0 — 2026-10-26

重构：适配 OAI Core 0.2 统一 Agent 架构，重构为 DSH Native Session Adapter。

### 架构与职责变更

- **架构简化**：全面移除独立 Android Gateway 服务、设备协议 v2 实现、账号注册表及每账号 SQLite 数据库；设备连接与认证统一由 OAI Core 负责。
- **最终架构**：`Android App ↔ OAI Core ↔ DSH Native Session Adapter ↔ DSH`。
- **部署级共享会话**：声明 `sessionScope: "deployment"`，通过 `sessionQuery.listSessions()` 读取宿主真实会话，使终端已有会话、新建会话与 App 创建会话完全互通。
- **真实宿主生命周期**：会话历史直接读取 `readSurface()`，使用 `requestId` 关联原生 `source.rpcId` 与 turn ID，精准转发 `assistant-stream` 增量，避免并发 turn 干扰。
- **动态能力协商**：根据宿主真实提供的服务注入动态声明 `list`, `history`, `create`, `send`, `rename`, `cancel`, `stream`。因原生删除与归档不可靠，明确置为 `false`，不使用本地隐藏伪装。
- **防代码漂移机制**：新增 `tools/verify-upstream-drift.mjs`，与上游 `open-android-intelligence` 仓库中的参考实现保持双向严格校验。
- **安全与权限边界**：明确 DSH 共享会话不继承 OAI 账号设备 Token，会话桥 Token 仅用于 Core 内部通信。

---

## 0.2.0 — 2026-10-21

功能补全：0.1.0 中标记为未实现的能力全部落地，并保持 App 零修改。

### 新增

- 消息批次：`POST /conversations/{id}/message-batches`，1–20 成员、`newline-v1`、聚合字节上限、共享 generation、成员独立状态与历史 `batchId`。
- `/new`：在网关内新建 DSH 会话并回发 `conversation.command.result`，源消息保留。
- 斜杠命令执行：App 发送的 `/permission`、`/compact` 等宿主人机命令直接执行，输出以 assistant 消息回到时间线；未知命令仍按普通文本交给模型。
- 审批卡片：`approval/request` answerer（优先于 Web UI）→ `conversation.approval.requested` / `resolved` + `POST /approvals/{id}/decisions`，只提供 `once`/`deny`，300 秒超时。
- WebSocket 事件传输：`/open-android-intelligence/v2/events/ws`，九 header 签名握手、游标重放、实时帧、Ping 心跳、410 游标过期；App 自动优先使用，失败回落 SSE。
- 邀请配对：`POST /sessions/invite/challenge`、`/sessions/invite/exchange`（别名 `/pairings/exchange`）、`tools/admin.mjs`（create/list/revoke，短码与深链）。
- 设备密钥登录：`POST /sessions/device/challenge`、`POST /sessions/device`，已配对设备 + installation 双重绑定。
- 设备能力：能力发布（JCS Schema 摘要复核、持久化）、请求队列、claim/result/detail、`pendingDeviceRequests` 基线快照、两个 Agent 作用域工具 `open_android_capabilities` / `open_android_device`。
- 历史媒体原件：`cache-grant` 短期授权 + `content` 回读，图片/文件均保存宿主附件引用。
- 错误码映射补齐（配对、审批、幂等、附件等），`tools/` 进入 npm files。

---

## 0.1.0 — 2026-10-20

首个可安装版本：把 Open Android Intelligence App 接入 DeepSeek Harness。
