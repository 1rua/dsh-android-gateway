# dsh-android-gateway

把 **Open Android Intelligence** 手机客户端接入 **DeepSeek Harness（DSH）** 的宿主插件。
手机端继续使用它原有的工作台、会话流、附件、命令目录与设备插件，DSH 成为与
Hermes / OpenClaw 同级的「又一个 Agent 宿主」。

- 协议：Open Android Intelligence **Gateway Protocol v2.1**
- 形态：DSH Bundle（Cordis 宿主插件），复用 DSH Web 服务器的 HTTP 端口
- App 侧改动：**零修改**
- 契约：只读快照自 App 仓库 `gateway-contract`（提交 `745e2cf`），核心摘要
  `sha256:032f5802…4d23` 与 App 硬编码值逐字节一致

## 能力

| 能力 | 状态 |
|---|---|
| 协议协商（核心 Schema 摘要校验） | ✅ |
| 密码登录 / refresh 轮换 / 登出 / 解除配对 | ✅ |
| 九 header Ed25519 请求签名、时间窗、nonce 防重放、幂等账本 | ✅ |
| SSE 事件流 + 游标断线续传 + 心跳 | ✅ |
| 会话列表 / 创建 / 读取 / 改名 / 归档 / 删除墓碑 | ✅ |
| 发送消息（文本 + 附件）、消息状态、流式正文、完成 | ✅ |
| 停止生成（`generation-cancel-v1`） | ✅ |
| 历史分页与 `clientMessageId` 查回 | ✅ |
| 命令目录（来自 DSH 命令注册表） | ✅ |
| 附件三段式上传（加密暂存、Digest 校验、TTL） | ✅ |
| 会话组织（文件夹 / 排序 / 分配，`conversation-management-v1`） | ✅ |
| 基线快照 `GET /sync/snapshot` | ✅ |
| 消息批次（1–20 条、`newline-v1`、聚合输入） | ✅ |
| `/new` 命令（新建会话 + `conversation.command.result`） | ✅ |
| 斜杠命令执行（`/permission`、`/compact` 等宿主人机命令） | ✅ |
| 审批卡片（`agent-approval-cards-v1`，一次/拒绝） | ✅ |
| WebSocket 事件传输（`/events/ws`，先重放后实时） | ✅ |
| 邀请配对（一次性短码 + `oai://pair` 深链） | ✅ |
| 设备密钥登录（已配对设备免密换会话） | ✅ |
| 设备能力请求（发布 / claim / result + 两个模型工具） | ✅ |
| 历史媒体原件（`cache-grant` + `content`） | ✅ |
| 会话镜像（`session-mirror-v1`） | ❌ 未声明，App 自动降级 |

能力位只在真正实现时声明（契约 §4）。未声明的能力不会出现在协商结果里，App 会
隐藏或降级对应 UI，而不是给用户一个点了没反应的按钮。

## 架构

```
Android App ── HTTP/SSE/WS ──▶ DSH Web 服务器（ctx.webServer，同一端口）
                              └─ /open-android-intelligence/v2/*
                                   └─ dsh-android-gateway
                                        ├─ http/         路由、原始 header/body、信封、SSE、WebSocket
                                        ├─ auth/         签名验证、nonce、幂等
                                        ├─ core/         协商/账号/会话/消息/批次/审批/附件/组织
                                        ├─ devices/      能力发布、请求队列、claim/result、模型工具
                                        ├─ dsh/          sessionController / commands / uploads / attachments
                                        └─ store/        每账号 SQLite（node:sqlite）
```

详细设计见 [docs/design/001-architecture.md](docs/design/001-architecture.md)。

关键设计：

- **宿主真源**：会话历史以 DSH Session 事件日志为准，网关只保存
  `conversationId ↔ dsh_session_id` 映射、消息账本与幂等终态，避免两份正文漂移。
- **零新增端口**：路由挂在 DSH Web 服务器上，手机只需填写一个地址
  （例如 `http://192.168.1.10:43535`）。
- **账号隔离**：账号注册表（用户名 + scrypt 摘要）与每账号 SQLite / 附件目录 /
  主密钥物理分离；先解析账号再打开账号库（契约 §5.1）。
- **默认失败关闭**：缺少必需 DSH 服务、契约摘要不一致、签名/游标/幂等失败都拒绝，
  不猜测、不降级成不安全行为。

## 安装

### 1. 构建

```bash
npm install
npm run build       # tsc + 复制契约快照到 lib/
npm test            # 契约向量 + 存储 + 核心闭环 + HTTP
```

### 2. 安装到 DSH profile

在 DSH 会话中使用插件管理工具安装本目录（绝对路径）：

```text
plugin_manager action=install_bundle target=/absolute/path/to/dsh-android-gateway
```

或者手动把本包加入 profile 的依赖并在 `dsh.profile.bundles` 中登记。安装后插件
会在 profile 的插件列表中显示「Android 网关 / Android Gateway」。

### 3. 取得登录凭据

首次激活时若账号表为空，插件会自动创建一个账号，并把**一次性明文凭据**写到：

```text
$DSH_HOME/dsh-android-gateway/setup-account.json   （权限 0600）
```

内容包含 `username`、`password`、`accountId`、`deploymentId`。手机端连接成功后请
删除该文件。

也可以预先在插件配置里声明账号（密码仅在启动时用于生成摘要，不会明文落盘）：

```yaml
- id: dsh-android-gateway
  name: dsh-android-gateway
  config:
    defaultUsername: android
    accounts:
      - username: alice
        password: "change-me"
    workspace: /path/to/workspace   # 新会话的工作目录，缺省用 DSH 默认目录
```

### 4. 手机端连接

1. 在 App 中新增 Gateway 账号，地址填写 DSH Web GUI 的地址，例如
   `http://192.168.1.10:43535`（手机与 DSH 主机需网络可达；明文连接时 App 会持续
   显示未加密警告，这是契约允许的显式 HTTP 模式）。
2. 用户名 / 密码填写 `setup-account.json` 或配置中的账号。
3. 设备公钥由 App 生成并随登录注册；之后所有请求都用 Ed25519 签名。
4. 已配对设备可使用「设备密钥登录」免密换新会话；新手机可用一次性邀请短码配对：

   ```bash
   node tools/admin.mjs invite create --account android --url http://127.0.0.1:43535
   ```

   把输出的短码或 `oai://pair?...` 深链交给 App（默认 300 秒、一次性）。

DSH Web GUI 默认监听 `127.0.0.1`。若手机需要从局域网连接，请显式配置 DSH 的
监听地址（DSH 侧配置，不在本仓库范围）。生产环境建议配置 HTTPS；本插件在协商中
对明文部署返回 `tlsSpkiSha256: null`，App 会保持未加密提示。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `workspace` | DSH 默认目录 | 新建会话的工作目录 |
| `dataDir` | `$DSH_HOME/dsh-android-gateway` | 网关数据根目录 |
| `defaultUsername` | `android` | 自动创建账号的用户名 |
| `accounts` | `[]` | 预置账号（`username` + `password`，可选 `accountId`） |
| `attachmentTtlSeconds` | `3600` | 附件暂存 TTL（协商下发） |
| `eventRetentionSeconds` | `86400` | 事件保留时间（游标过期窗口） |
| `maxClockSkewSeconds` | `120` | 允许的时钟偏差（协商下发） |
| `maxAttachmentBytes` | `268435456` | 附件暂存上限 |
| `tlsSpkiSha256` | `null` | 显式 TLS 身份指纹；明文部署保持 null |
| `heartbeatMs` | `15000` | SSE 心跳间隔 |

## 数据与安全

- 每账号数据库：`$DSH_HOME/dsh-android-gateway/accounts/<accountId>/gateway.db`
- 附件暂存：AES-256-GCM 分块加密（每账号主密钥 `master.key`，0600）
- access token / refresh credential / 密码：只存摘要
- 事件流按账号隔离；游标过旧返回 `CURSOR_EXPIRED` 与可重建资源列表
- 本插件不实现「零保留」承诺：宿主 Session 历史由 DSH 保存；网关只保存交付所需的
  映射、幂等结果与短期暂存

## 已知限制（v0.1）

1. **删除会话是网关墓碑 + 宿主归档**：DSH 目前没有公开的 Session 删除 API，
   `DELETE /conversations/{id}` 会停止生成、尽力归档并让网关永久隐藏该会话，
   DSH Web UI 的归档区仍可能看到它。后续会跟进宿主删除能力。
2. **历史媒体**：`metadata` 端点返回 `remoteAvailable:false`（原件归宿主，网关按契约
   删除暂存字节）；`cache-grant`/`content` 返回 `CAPABILITY_UNAVAILABLE`。App 本地
   已缓存的原件仍可直接保存/下载。
3. **插件热重载会中断进行中的 SSE 生成流**：热重载后手机端可能停留在“正在思考”，
   重启 App 会从历史恢复。正常重启也会丢失进行中的增量，历史与最终正文仍可读。
4. **未声明**：消息批次、会话镜像、审批卡片、邀请配对、设备密钥会话、WebSocket
   传输、设备能力（通知/短信/通话记录）。App 会按契约降级。
5. **明文 HTTP 无设备身份**：与契约一致，建议在可信内网或配置 HTTPS 后使用。

## 开发

```bash
npm run typecheck
npm test
npm run build
```

目录：

```
src/protocol/      契约快照封装、core hash、Ed25519 验签
src/auth/          原始 HTTP → VerifiedRequest
src/http/          路由、header/body 校验、信封、SSE
src/core/          协商、账号、会话/消息/生成、附件、组织
src/dsh/           DSH 服务桥与事件订阅
src/store/         每账号 SQLite、账号注册表、密码摘要
contract/          Gateway Protocol v2.1 只读快照（schemas/src/vectors）
test/              契约向量、存储、核心闭环、HTTP 集成
docs/              设计、调研与评审
```

## 许可与致谢

- 本仓库：MIT
- Gateway Protocol v2.1 契约快照来自
  [open-android-intelligence](https://github.com/1rua/open-android-intelligence)，MIT；
  快照许可见 `contract/LICENSE-upstream`
- 协议行为对照参考了同作者的 Hermes / OpenClaw 宿主插件实现
