# 变更记录

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
