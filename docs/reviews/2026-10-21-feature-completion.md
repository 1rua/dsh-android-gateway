# v0.2 功能补全验证报告（2026-10-21）

## 结论

0.1.0 中列为「未实现」的能力已全部落地：消息批次、`/new`、斜杠命令执行、审批卡片、
WebSocket、邀请配对、设备密钥登录、设备能力请求与历史媒体原件。

- DSH 插件：`dsh-android-gateway@0.2.0`，仍为 Bundle 形态，零修改 App。
- 自动化：`npx tsc --noEmit` 通过；`npx vitest run` **201/201**。
- 真机：Android 模拟器（`dsh-oai`）安装 App `2.1.1`（core hash 与网关一致），
  以下闭环均实际操作验证。

## 协商结果

`POST /negotiate` 返回：

- `conversationUi`：`agent-command-catalog-v1`、`agent-command-new-v1`、
  `agent-approval-cards-v1`、`message-batches-v1`、`newline-v1`、
  `generation-cancel-v1`、`conversation-management-v1`；
- `auth`：`password`、`refresh`、`account-invitation`、`device-key`；
- `limits`：`maxBatchMembers: 20`、`maxBatchBytes: 65536`。

## 自动化覆盖

| 范围 | 用例数 | 结果 |
|---|---:|---|
| 契约向量 | 6 | ✅ |
| 账号 / 会话 / 组织存储 | 38 | ✅ |
| 核心闭环（登录、会话、消息、批次、`/new`、斜杠命令、审批、历史媒体、设备路由） | 12 | ✅ |
| HTTP 传输（含新增预认证路由、WS） | 73 | ✅ |
| 邀请 / 设备密钥 / 管理 CLI | 39 | ✅ |
| 设备子系统（存储、服务、工具） | 43 | ✅ |
| 合计 | **201** | ✅ |

设备工具 Schema 最初被 DSH 注册器拒绝两次（`enum` 缺 `type`、`minLength` 不在允许
子集）；已按 DSH 的封闭 JSON Schema 子集修正，并在真机上确认两个工具均注册成功。

## 真机验证

### 1. 消息批次

App 发送一条消息时按 `message-batches-v1` 提交（界面显示「同一批次 · 1 条」），
网关返回 `accepted`，Agent 正常回复 `OK`。此前失败原因是 App 批次里的
`clientConversationId` 是服务端会话 ID，而网关误按创建时的客户端 ID 校验；已按
参考实现改为「若出现必须等于路径会话 ID」。

### 2. `/new`

App 输入 `/new` 后，网关新建 DSH 会话并回发 `conversation.command.result`
（`outcome: created-conversation`）；App 自动切换到「新对话」，源会话保留命令消息。

### 3. 斜杠命令

App 发送 `/permission read-only`，网关注入宿主人机命令并执行，时间线出现
assistant 消息 `preset read-only`。这修复了命令目录「只能看不能执行」的缺口；
未知命令仍按普通文本交给模型。

### 4. 审批卡片

在 `read-only` 预设下让 Agent 创建文件，触发沙箱提权审批：

- App 显示「命令需要你的批准」、中文说明与 300 秒倒计时；
- 网关事件为 `conversation.approval.requested`（`once`/`deny` 两个档位），超时后
  `conversation.approval.resolved` 的 `decision=timeout`；
- 决策端点 `POST /approvals/{id}/decisions` 由自动化测试覆盖（含 `allowed-once`
  与重复决策 409）。

实验环境里按钮点击窗口总被模型思考时间耗尽，因此未在 UI 上完成一次「点按允许」；
卡片渲染、事件时序与决策协议均已验证。

### 5. WebSocket

- 宿主机用真实签名完成 `/events/ws` 握手，返回 `101 Switching Protocols`；
- App 日志 `event stream attempt ... viaWs=true`，随后状态显示「已连接」；
- 服务端每 15 秒发送 Ping；App 的平台生命周期流仍使用 SSE（其代码中显式
  `webSocketTransport = null`），因此日志里仍能看到 SSE 心跳，这是双通道设计而非回退。

### 6. 设备能力工具

新会话中要求模型调用 `open_android_capabilities`：

- 工具位于模型清单，调用成功；
- 因为模拟器没有安装任何手机能力插件，结果为
  `available=false`、`capabilities=[]`，并给出诊断；
- `open_android_device` 同时注册成功（诊断 `capabilities=true device=true`）。

### 7. 邀请配对与设备密钥登录

用 `tools/admin.mjs invite create` 生成一次性短码，真实 HTTP 完成：

```text
INVITE OK acct_mvgqwi6bxkzpha1sn4 dev_mvgwu6a7ajxot9rlt5 sess_mvgwu6a8j946350401
DEVICE KEY OK sess_mvgwu6aqd6ai38qb5e dev_mvgwu6a7ajxot9rlt5
```

签名预像与 7 字段事实逐字节使用契约前缀 + JCS；设备密钥登录只对已配对设备签发，
installation 与 deviceId 双重绑定。

## 证据

- [app-device-tool.png](evidence/2026-10-21-feature-completion/app-device-tool.png)：
  App 中模型调用 `open_android_capabilities` 并返回 `available=false`。
- 0.1.0 的会话、图片回复与命令目录截图见
  [2026-10-20](2026-10-20-device-verification.md)。

## 未覆盖与后续

- `conversation-mirror-v1` 未声明（App 自动降级）。
- 审批按钮的 UI 点按未在实验窗口内完成；决策端点有自动化覆盖。
- 设备能力发布来自真实手机插件（通知/短信/通话）未在模拟器安装，端到端只验证了
  「无能力」空态、工具注册与发布/请求路由。
- 会话镜像、设备参数语义 Schema 校验可作为后续增强。
