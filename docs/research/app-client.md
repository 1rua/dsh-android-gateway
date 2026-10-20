# Open Android Intelligence App 客户端功能盘点与网关依赖分析

> 目标：从 Android 客户端源码出发，盘点所有依赖「网关（Gateway）」的功能，回答“DSH 网关插件必须实现哪些能力，才能保留 App 的全部设计功能”，并给出可执行的最小可用范围（MVP）。
>
> 分析基线：`open-android-intelligence` 仓库 HEAD `745e2cf4`（2026-10-20 19:55 +08:00），Android `versionName = 2.1.1`（`apps/android/app/build.gradle.kts:63`）。`tmp/artifacts/*/app-full-debug.apk` 的构建时间为 2026-10-12～10-13，早于源码 HEAD，**本文以源码为准**，不把旧 APK 的行为当作当前契约。
>
> 协议基线：Gateway Protocol v2.1，核心 Schema 摘要 `sha256:032f580246eb4a214624bded717819b4d5a76191208207edc9e5a4607f5c4d23`。该摘要已在本地用 `gateway-contract/schemas/` 七个文件复算通过，并与 DSH 仓库内置的 `contract/schemas/` 逐字节一致。
>
> 同仓已有两份互补文档：`docs/research/gateway-protocol.md` 是服务端协议实现规格，`docs/research/dsh-host-api.md` 是 DSH 宿主 API 调研。本文不重复推导签名算法和 Schema 细节，只聚焦 **App 作为客户端的真实行为、能力门禁、降级和验收**。

---

## 0. 先读这段：结论摘要

1. **App 是一个“封闭 Schema + 强门禁”的客户端。** 协商响应、命令目录、时间线、附件状态、审批、设备请求都按字段逐项读取；协商响应中多一个未知字段、`features` 里的基础能力不是单值字符串、`conversationUi` 多回一个客户端没声明的键，都会让**整个登录失败**（`[G]negotiation/NegotiationClient.kt:156-203, 172`）。
2. **最小可用网关不是“只做登录 + 发消息”。** App 在登录后会自动执行：`GET /conversations`、`GET /commands`、`GET /pairings/current`、`GET /events`，并在发送首条消息时 `POST /conversations`。其中 `/commands` 和 `/pairings/current` 的调用**不受协商能力位门禁**，缺了就会出现持续错误提示或命令面板报错。
3. **App 有六个“契约正文没写、但参考宿主都实现了”的硬依赖**：`/sessions/invite/challenge`、`/sessions/device/challenge`、`/pairings/current`、`POST /pairings/current/capabilities`、`GET /device-requests/{id}`、`GET /sync/snapshot`。前两个只在邀请/设备密钥登录时用到；`/pairings/current` 在每次连接后必然被调用；`/sync/snapshot` 只在事件游标过期时用到；`/device-requests/{id}` 只在 DSH 真的要下发设备请求时用到。
4. **App 没有模型选择、没有“重新生成/继续生成”、没有服务端搜索、没有共享文件夹。** 不要为这些需求设计网关端点；它们不存在于客户端（详见 §7.2、§8.3）。
5. **消息批次、审批卡、会话管理、停止生成都是“协商到才启用”的能力。** DSH 不实现时，App 会明确显示“不支持/不可用”，不会本地伪造；但“消息防抖”设置项仍然显示，只是不生效（App 自身的不一致，见 §8.2）。
6. **思考内容和工具调用不是协议字段，而是助手正文里的文本标记**：`<think>…</think>` 与 `<tool_call name="…"><command>…</command><output>…</output></tool_call>`。网关只要把 Agent 文本按这些标记下发，App 就会渲染思考折叠卡和工具卡；不写标记就只是普通 Markdown 文本。

---

## 1. 口径与方法

### 1.1 路径缩写

本文源码引用使用以下缩写（均为 `open-android-intelligence` 仓库内相对路径）：

| 缩写 | 实际路径 |
|---|---|
| `P` | `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/` |
| `G` | `apps/android/gateway-client/src/main/kotlin/com/openandroidintelligence/gateway/` |
| `D` | `apps/android/conversation-data/src/main/kotlin/com/openandroidintelligence/conversation/data/` |
| `U` | `apps/android/conversation-ui/src/main/kotlin/com/openandroidintelligence/conversation/` |
| `M` | `apps/android/conversation-domain/src/main/kotlin/com/openandroidintelligence/conversation/` |

例：`[P]GatewayLoginScreen.kt:229-282` = `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/GatewayLoginScreen.kt` 第 229～282 行。

### 1.2 “依赖网关”的判定

本文把以下三类都算“依赖网关”：

1. **HTTP 端点依赖**：App 会主动请求的 `/open-android-intelligence/v2/*` 路径。
2. **事件流依赖**：App 从 `GET /events`（SSE，优先 WebSocket）消费的事件类型与字段。
3. **协商能力位依赖**：`features.conversationUi` 中的键决定 App 是否启用某个界面/交互，以及缺失时的降级文案。

设备插件、通知采集、气泡、审计、主题等本地功能，只在它们需要网关的地方计入。

### 1.3 证据边界

- 本文是**源码静态分析 + 参考宿主路由/行为比对**，未在真机上重跑。
- APK 只用于确认历史构建存在，不作为行为依据。
- 参考宿主：`/mnt/data/projects/hermes-gateway-plugin/`（Python，Hermes 2.2.0）与 `/tmp/dsh-recon/openclaw-gateway-plugin/`（TypeScript，OpenClaw 1.1.0）。两者版本不同，**能力并不完全一致**（例如 OpenClaw 固定版不声明审批卡，见 §6.1）。

---

## 2. App 连接网关的完整用户流程

### 2.1 入口与可输入项

| 输入项 | 是否必填 | 格式/说明 | 源码 |
|---|---|---|---|
| 网关地址 | 必填 | 只接受 `http://` 或 `https://`，不带 scheme 时自动补 `https://` | `[P]GatewayLoginScreen.kt:229-248, 646-652`；`[G]http/GatewayEndpoint.kt:66-77` |
| 用户名 / 账号 | 必填 | 纯文本，登录时 `trim()` | `[P]GatewayLoginScreen.kt:255-262, 278` |
| 密码 / 访问凭据 | 必填（密码登录） | `CharArray`，提交后立即清零 | `[P]GatewayLoginScreen.kt:264-282, 305-309` |
| 邀请短码 | 邀请登录时必填 | 16 位十六进制（`[A-F0-9]{16}`），App 会 `trim().uppercase()` | `[G]auth/GatewayAuthClient.kt:91-95`；`[P]GatewayRuntime.kt:483` |
| 二维码/深链内容 | 可选 | `oai://pair?gateway=…&account=…&code=…&invitationId=…&identityFingerprint=sha256:…&expiresAt=…`；可粘贴，也可由外部扫码器打开深链 | `[P]GatewayLoginScreen.kt:77-93, 219-227`；`apps/android/app/src/main/AndroidManifest.xml:44`；`[P]MainActivity.kt:66-75, 88` |

**没有内置二维码扫描器。** App 只接受粘贴的 `oai://pair?…` 文本或系统深链；二维码由宿主/运维生成，扫码动作发生在 App 之外。邀请内容解析后仍要求用户确认账号名，且 `invitationId` 非空、`expiresAt` 未过期、`identityFingerprint`（可选）格式为 `sha256:<64 hex>`（`[P]GatewayLoginScreen.kt:88-93`）。

### 2.2 URL 规范化与路径前缀

- 地址首尾空白会被 trim，末尾 `/` 会被去掉；没有 `://` 时补 `https://`（`[P]GatewayLoginScreen.kt:646-652`）。
- 只接受 `http` / `https`；其他 scheme 直接返回 `null`，登录按钮不可用（`[G]http/GatewayEndpoint.kt:66-77`；`[P]GatewayLoginScreen.kt:96-99`）。
- **不支持路径前缀。** 所有请求由 `URL(baseUrl.trimEnd('/') + target)` 拼接，而签名目标固定为 origin-form 的 `/open-android-intelligence/v2/...`（`[G]http/GatewayTransport.kt:210-217`；`[G]http/CanonicalTarget.kt:19`）。如果用户输入 `https://host/prefix`，实际请求路径会变成 `/prefix/open-android-intelligence/v2/...`，与签名目标不一致，服务端只能拒绝（`NON_CANONICAL_TARGET` 或 404）。因此 **网关必须挂在 origin 根路径**，用端口或独立域名区分部署。
- 不跟随 HTTP 重定向：`instanceFollowRedirects = false`（`[G]http/GatewayConnectionFactory.kt:27-31`）。部署时不要用 301/302 把 HTTP 跳到 HTTPS，App 会直接失败；要让用户输入最终地址。

### 2.3 TLS / 明文要求

| 场景 | App 行为 | 源码 |
|---|---|---|
| `https://` + 协商返回 `tlsSpkiSha256` | 固定该 SPKI；证书链中任一证书的 SPKI 匹配即通过；之后每次连接都要求同一身份（`deploymentId` + pin） | `[G]http/SpkiPinning.kt:27-55`；`[P]GatewayIdentityTrustStore.kt:36-64` |
| `https://` + 协商返回 `null` | 使用 Android 系统 CA 信任（`TLS_SYSTEM_TRUST`），不固定指纹；**自签名证书会失败** | `[G]http/GatewayEndpoint.kt:48-52`；`[P]GatewayIdentityTrustStore.kt:36-49` |
| 协商返回 SPKI 但证书不匹配 | 握手后、读取响应字节前失败（`PIN_MISMATCH`） | `[G]http/GatewayConnectionSecurity.kt:29-43` |
| `http://` 用户显式输入 | 允许，但始终显示“未加密（HTTP）”警告；登录页持续提示；设置页把传输安全标为危险色 | `apps/android/app/src/main/AndroidManifest.xml:17-30`；`[P]GatewayLoginScreen.kt:250-253, 587-643`；`[P]SettingsScreen.kt:563-600` |
| 已有 TLS 身份的账号改用 `http://` | 对同 host 的默认 HTTP 入口（端口 80 或未写端口）会拒绝（`TLS_DOWNGRADE_REFUSED`）；其他端口组合不会命中该检查，但仍然没有任何可核验身份 | `[P]GatewayIdentityTrustStore.kt:26-34` |
| 带 pin 的 profile 用明文 | 类型边界直接拒绝（`PIN_REQUIRES_HTTPS`） | `[G]http/GatewayHttpClient.kt:21-38`；`[G]http/GatewayConnectionSecurity.kt:29-42` |

补充事实：

- **没有 `network_security_config.xml`**；App 在 Manifest 里直接 `android:usesCleartextTraffic="true"`，因此任意 host 的 `http://` 都能连，不限于 loopback 或 `10.0.2.2`。安全边界靠“用户显式输入 + 持续警告 + 不允许降级”，不是系统网络策略。
- `10.0.2.2:8045` 只是登录页 placeholder 示例（`[P]GatewayLoginScreen.kt:244`）；App 没有默认端口。参考宿主的默认监听端口是 `0.0.0.0:8045`（`docs/superpowers/integrations/hermes/catalog/PR.md:47`），这是**部署约定**，不是 App 常量。
- 开发调试常用 `adb reverse tcp:8045 tcp:8045`，然后在手机里填 `http://127.0.0.1:8045` 或 `http://10.0.2.2:8045`；这属于部署方式，App 不做特殊识别。

### 2.4 协议协商（登录前）

`POST /negotiate` 在认证前执行，请求不含秘密（`[G]negotiation/NegotiationClient.kt:105-140`）：

- 客户端声明 `protocol {major:2, minor:1}`、`installationId`、`appVersion`、`platform:"android"`、`platformApi`。
- `features.auth` 声明 `["password","account-invitation","refresh","device-key"]`。
- `features.messages` 声明 `["chat-v1"]`；`attachments` 声明 `["staged-sha256-v1"]`；`events` 声明 `["sse-cursor-v1"]`；`deviceRequests` 声明 `["risk-queue-v1"]`。
- `features.conversationUi` 声明 7 个键：`agent-command-catalog-v1`、`agent-command-new-v1`、`agent-approval-cards-v1`、`message-batches-v1`、`newline-v1`、`generation-cancel-v1`、`conversation-management-v1`（`[G]negotiation/NegotiationClient.kt:21-29`）。
- `schemaHashes.core` 发送本地契约摘要。
- 额外发送 `X-Open-Android-Intelligence-Refresh-Replay: v1`（`[G]negotiation/NegotiationClient.kt:130-137`），用于协商 refresh 结果重放扩展；服务端不支持时可以不回该 header，App 会把 `refreshReplaySupported` 置 false。

**响应必须满足的严格条件**（任何一条不满足都会 `NEGOTIATION_FAILED`，登录直接失败）：

1. HTTP 200；否则 406/409 映射为 `PROTOCOL_INCOMPATIBLE`，其他状态映射为 `NEGOTIATION_FAILED:<status>`（`[G]negotiation/NegotiationClient.kt:143-149`）。
2. 顶层 `protocol` 必须是字符串 `"2.1"`（`[G]negotiation/NegotiationClient.kt:153-155`）。
3. `data` 对象只能包含 `protocol`、`features`、`limits`、`gatewayIdentity` 四个键（`[G]negotiation/NegotiationClient.kt:156-160`）。
4. `data.protocol` 必须是 `{major:2, minor>=0}`；major 必须等于 2（`[G]negotiation/NegotiationClient.kt:161-164`）。
5. `data.features` 必须包含 `auth`、`messages`、`attachments`、`events`、`deviceRequests`，可选 `conversationUi`；不能有别的键（`[G]negotiation/NegotiationClient.kt:166`）。
6. `auth` 是非空字符串数组，且每一项都属于 `password/account-invitation/refresh/device-key`；否则 `NEGOTIATION_FAILED:auth`（`[G]negotiation/NegotiationClient.kt:167`）。
7. **`messages`、`attachments`、`events`、`deviceRequests` 必须是单值字符串**，且分别精确等于 `chat-v1`、`staged-sha256-v1`、`sse-cursor-v1`、`risk-queue-v1`（`[G]negotiation/NegotiationClient.kt:168-170`）。注意：请求里是数组，响应里是字符串，不能照抄请求形状。
8. `conversationUi` 若存在，必须是字符串数组，且每一项都在客户端声明的 7 个键内；**多回一个 `conversation-mirror-v1` 或 `attachment-status-v1` 会让协商整体失败**（`[G]negotiation/NegotiationClient.kt:171-173`）。
9. `limits` 必须包含 `attachmentTtlSeconds`、`eventRetentionSeconds`、`maxClockSkewSeconds`，可选 `maxBatchMembers`、`maxBatchBytes`；所有值必须是整数，前三个分别 `>=1`、`>=1`、`>=0`（`[G]negotiation/NegotiationClient.kt:174-178`）。
10. `gatewayIdentity` 必须包含 `deploymentId`（符合 wire ID `[A-Za-z0-9._~-]{1,128}`），可选/可空 `tlsSpkiSha256`；pin 若存在必须是 `sha256:` + 64 位小写 hex，且不能是全零（`[G]negotiation/NegotiationClient.kt:179-186`；`[G]http/SpkiPinning.kt:27`）。

协商结果会被绑定到后续的 `negotiationId`，登录时原样回传。服务端必须拒绝“同一 `negotiationId` 换不同请求体”的重放。

### 2.5 四种认证方式

| 方式 | App 请求 | 关键要求 | 源码 |
|---|---|---|---|
| 密码登录 | `POST /sessions/password`，body 含 `negotiationId`、`username`、`password`、`installation{installationId,displayName,devicePublicKey}` | `displayName` 取 `Build.MODEL`；`devicePublicKey` 是 Ed25519 公钥的 base64url；响应必须含 `accountId`、`deviceId`、`sessionId`、`accessToken`、`refreshCredential` | `[G]auth/GatewayAuthClient.kt:64-88, 236-259`；`[P]GatewayRuntime.kt:466-487` |
| 邀请配对 | 先 `POST /sessions/invite/challenge`，再 `POST /pairings/exchange` | challenge 请求含 `accountId`、`negotiationId`、`code`、`installation{...}`；响应 `data` 必须**恰好**是 `{challengeId, accountId, negotiationId, installationId, devicePublicKey, nonce, expiresAt}`；`exchange` 提交 `accountId`、`negotiationId`、`challengeId`、`signature`；签名预像是 `OPEN_ANDROID_INTELLIGENCE_PAIRING_V1\n` + JCS(challenge facts) | `[G]auth/GatewayAuthClient.kt:91-105` |
| 设备密钥登录 | 先 `POST /sessions/device/challenge`，再 `POST /sessions/device` | challenge 响应 `data` 必须**恰好**是 `{challenge, accountId, negotiationId, installationId, deviceId, nonce, expiresAt}`；签名预像是 `OPEN_ANDROID_INTELLIGENCE_DEVICE_SESSION_V1\n` + JCS(facts)；只能在已保存账号资料（同 URL + 同用户名）下使用 | `[G]auth/GatewayAuthClient.kt:107-120`；`[P]GatewayLoginScreen.kt:400-402`；`[P]GatewayRuntime.kt:474-478` |
| 刷新/轮换 | `POST /sessions/refresh` | 必须携带 `negotiationId`、`accountId`、`installationId`、`deviceId`、`refreshCredential`；响应字段与登录相同，且必须返回新的 `refreshCredential` | `[G]auth/GatewayAuthClient.kt:125-142`；`[P]GatewayRuntime.kt:826-870` |

**登录响应的硬要求**：`refreshCredential` 必须存在，否则 App 直接 `LOGIN_FAILED:missing-refresh`（`[G]auth/GatewayAuthClient.kt:245-247`）。App 会把 refresh credential 按 ISO-8859-1 字符串取出并保存字节（`[G]auth/GatewayAuthClient.kt:246-247`），所以**服务端应使用纯 ASCII 的不透明串**（base64url/hex），不要放任意 Unicode。

`pairingSummary` 在 App 里按字符串读取（`[G]auth/GatewayAuthClient.kt:253`），而 `session.schema.json#/$defs/pairingSummary` 定义的是对象。两宿主目前都不返回它，App 设置页会显示“Gateway 未提供配对摘要”。DSH 若返回对象，App 会忽略；若想显示摘要，需要返回字符串（但这不属于协议 Schema）。

### 2.6 网关身份固定与“重新确认”

- 登录成功后，TLS 连接会把 `{deploymentId, tlsSpkiSha256}` 保存到 `gateway-identities` SharedPreferences；key 由 `host|port|path|username` 的 SHA-256 组成（`[P]GatewayIdentityTrustStore.kt:51-90`）。明文连接不保存身份。
- 之后每次连接都会比对 `deploymentId` 与 pin；不一致返回 `GATEWAY_IDENTITY_CHANGED`（`[P]GatewayIdentityTrustStore.kt:36-49`）。
- 启动自动恢复时，TLS 连接如果没有已保存身份，会要求重新登录（`TLS_IDENTITY_RECONFIRMATION_REQUIRED`）（`[P]GatewayIdentityTrustStore.kt:26-33`）。
- 登录页在“TLS + 用户名非空 + 上次失败”时显示“重新确认网关身份”；确认后会清除该账号的旧身份和 refresh credential，要求重新密码登录（`[P]GatewayLoginScreen.kt:403-405, 423-428`；`[P]GatewayRuntime.kt:662-670`）。

### 2.7 配对与设备密钥如何生成、保存

| 材料 | 生成 | 保存 | 销毁 |
|---|---|---|---|
| `installationId` | 首次使用随机 `install_` + 32 位 hex，写 SharedPreferences | `P` 私有 SharedPreferences，`commit()` 成功才继续 | 卸载 App |
| 设备密钥（Ed25519） | 首次登录/首次需要时生成；Android Keystore 不生成 Ed25519，所以用软件 Provider 生成 PKCS#8/X.509 | 私钥 PKCS#8 用**不可导出的 Keystore AES-256-GCM 包装密钥**加密，磁盘帧 `[iv 12][ciphertextLen 4][ciphertext][publicSpki]`，落在 App 私有目录 | 移除账号/解除配对时删 Keystore alias 和文件 |
| refresh credential | 由 Gateway 在登录/刷新时签发 | 每个账号独立的 Keystore AES 包装密钥加密，`AtomicFile` 保存（`[iv][ciphertext]`） | 登出、移除账号、解除配对、身份重确认时删除 |
| 账号资料（非秘密） | 登录成功后保存 URL、用户名、`tlsTrustId`、`accountId/deviceId/sessionId` 绑定 | `AccountProfileStore` | 移除本机账号时删除 |

源码：`[P]DeviceKeySource.kt:13-30`；`[G]auth/Ed25519DeviceKeyStore.kt:33-111`；`[G]auth/AndroidKeystoreGatewayCredentialStore.kt:31-65`；`[P]GatewayRuntime.kt:1677-1727`。

**注意**：设备密钥是**每个 `profileId` 一把**，`profileId = base64url("$gatewayUrl|$username")`（`[P]GatewayRuntime.kt:1725-1727`）。同一手机连不同 Gateway/不同账号会有不同设备身份；换 URL 或改用户名会被视为新设备。

### 2.8 刷新会话的时机

App **不做本地定时续期**，只在以下时机轮换：

1. **冷启动恢复**：存在 refresh credential 时，先 `/negotiate`，再 `/sessions/refresh`，成功后 `establish`（`[P]GatewayRuntime.kt:939-1044`）。
2. **任意已认证 HTTP 请求返回 401**：`GatewayHttpClient.execute` 调 `sessionRenewal.refresh(...)` 一次，然后用新 session 重试原请求（`[G]http/GatewayHttpClient.kt:218-226, 245-262`）。
3. **事件流 401**：走共享的 `GatewaySessionRenewal` 恢复 episode，同一时刻只允许一个事件客户端发起刷新（`[G]http/GatewayHttpClient.kt:104-131`；`[G]auth/GatewaySessionRenewal.kt:60-114`）。
4. **设置页手动“刷新网关凭据”**（`[P]GatewayRuntime.kt:791-819`）。
5. **移除本机账号**时，如果本机有 refresh credential，会先轮换再 `DELETE /sessions/current?revokeRefresh=true`（`[P]GatewayRuntime.kt:674-733`）。

刷新失败的处理：

- 明确被拒绝（`credentialRefused`）→ 清 refresh、清 profile、进入 `REAUTHENTICATION_REQUIRED`，提示重新登录（`[P]GatewayRuntime.kt:881-900`）。
- 结果未知（例如响应丢失且网关未协商 refresh replay）→ `RECOVERY_PENDING`，保留凭据，提示稍后重试（`[P]GatewayRuntime.kt:820-824`）。
- 网络类瞬时失败 → 进入离线镜像，之后按 1s/2s/…/60s 退避重试（`[P]GatewayRuntime.kt:1000-1035`）。

### 2.9 启动恢复、离线镜像与前台保活

- App 启动时 `restoreSessionIfAvailable()`：仅在 `Disconnected`、且不是 `REAUTHENTICATION_REQUIRED`、且本地有 refresh credential 时执行（`[P]GatewayRuntime.kt:939-951`）。
- 恢复失败但属于瞬时 IO/网络错误时，进入 `ConnectionPhase.OfflineMirror`：显示本地加密镜像的历史，`allowSending=false`，命令目录直接抛 `OFFLINE_MIRROR`（`[P]GatewayRuntime.kt:914-938`）。
- 网络恢复/App 回前台会唤醒已有 owner：已连接时重启事件流并刷新工作台；离线时重连；未连接时尝试恢复（`[P]GatewayRuntime.kt:354-377`）。
- 有运行中的任务且通知开启时，App 会启动 `dataSync` 前台服务接收回复；任务结束/退出账号/关闭通知后停止（`apps/android/app/src/main/AndroidManifest.xml:47-50`；`docs/mvp/device-reads-and-reply-notifications.md`）。

### 2.10 登出、解除配对、移除本机账号

| 动作 | 网关请求 | App 的“确认后清理”规则 | 源码 |
|---|---|---|---|
| 退出当前登录 | `DELETE /sessions/current?revokeRefresh=<bool>`，只带 Bearer + Protocol/Account/Device/Session 头，**不要求签名** | 只有收到 2xx 才清 refresh/journal/last profile；否则保留并提示“登出未获 Gateway 确认” | `[G]auth/GatewayAuthClient.kt:145-177`；`[P]GatewayRuntime.kt:524-589` |
| 解除设备配对 | `DELETE /pairings/current`，**完整签名**（九 header + Idempotency-Key） | 响应 `data` 必须**恰好**包含 `deviceId` + 六个布尔字段（`deviceKeysRevoked`、`refreshRevoked`、`grantsRevoked`、`deviceRequestsRevoked`、`unconfirmedAttachmentsRevoked`、`sessionsRevoked`），且全部为 `true`；否则保留本机凭据并报“解除配对未获 Gateway 确认” | `[G]auth/PairingRevocationClient.kt:10-30`；`[P]GatewayRuntime.kt:734-789` |
| 移除本机账号 | 若在线且有 refresh：先 refresh 轮换，再 `DELETE /sessions/current?revokeRefresh=true`；然后清本机全部密钥/镜像/插件数据 | 失败则保留资料；这是**本机动作**，Gateway 账号和其他设备不受影响 | `[P]GatewayRuntime.kt:674-733` |

### 2.11 用户流程（文字版）

```text
启动
  └─ 有本地 refresh credential？
       ├─ 是 → POST /negotiate → POST /sessions/refresh
       │        ├─ 成功 → establish：
       │        │    ├─ GET /pairings/current（后台每 5s）
       │        │    ├─ GET /conversations（工作台首屏）
       │        │    ├─ GET /commands（命令目录）
       │        │    ├─ GET /events（SSE；先试 /events/ws）
       │        │    └─ 打开第一个未归档会话 → GET /messages
       │        └─ 失败 → 离线镜像 / 重新登录 / 失败提示
       └─ 否 → 登录页：
            ├─ 密码：POST /sessions/password
            ├─ 邀请：POST /sessions/invite/challenge → POST /pairings/exchange
            └─ 设备密钥：POST /sessions/device/challenge → POST /sessions/device
                 └─ 成功后同上 establish

首次发消息
  └─ 没有会话 → POST /conversations（clientConversationId 幂等）
       └─ POST /conversations/{id}/messages（clientMessageId 幂等）
            ├─ 有附件：POST /attachments → GET /attachments/{id} → PUT content → POST commit
            └─ 等待 SSE：conversation.message.delta / completed / status
```

---

## 3. 网关地址形式、端口与健康检查

### 3.1 地址形式

- **唯一合法形式**：`http(s)://<host>[:<port>]`，不带路径（带路径会导致签名目标与实际路径不一致；见 §2.2）。
- IPv6 字面量可用；WebSocket 握手会自行加 `[]`（`[G]ws/GatewayWebSocketTransport.kt:76-84`）。
- 不接受 `ws://`/`wss://`；WebSocket 由 App 自己从 `http(s)` + 固定路径 `/open-android-intelligence/v2/events/ws` 升级（`[G]ws/GatewayWebSocketTransport.kt:413-419`）。
- 协议基路径固定为 `/open-android-intelligence/v2`，不能通过配置修改（`[G]http/CanonicalTarget.kt:19`）。

### 3.2 端口约定

- App 没有默认端口；用户输入什么端口就连什么端口。
- 参考宿主默认监听 `0.0.0.0:8045`（Hermes），登录页 placeholder 也使用 `8045`/`8443` 示例。
- HTTPS 常见 443/8443；HTTP 常见 8045。DSH 应把“最终对外地址”完整告诉用户（含 scheme 和端口），不要让用户猜。

### 3.3 “连接健康检查”是什么

**App 不调用 `/health`。** 参考宿主确实提供 `/health`（例如 `docs/superpowers/plans/2026-09-03-live-device-e2e-test-report.md:94`），但 App 的健康判断完全来自协议层：

| 健康信号 | 含义 | App 展示 | 源码 |
|---|---|---|---|
| `ConnectionPhase` | `Disconnected / Negotiating / Authenticating / Failed / OfflineMirror / Connected` | 登录页状态条、设置页连接状态 | `[P]GatewayRuntime.kt:105-132`；`[P]GatewayLoginScreen.kt:511-575` |
| `EventStreamStatus` | `IDLE / CONNECTING / LIVE / RECONNECTING / FAILED` | 设置页连接详情、工作台顶栏 `connectionLabel` | `[G]events/EventStreamStatus.kt:12-35`；`[U]components/StateViews.kt:168-185` |
| SSE 心跳 | 注释行 `: ping` 或任意完整帧 | 有心跳即 `LIVE` | `[G]events/SseParser.kt:124-160` |
| 连续失败计数 | 6 轮都失败后停止重试并 `FAILED` | “实时通道已断开，暂时收不到新回复” | `[G]http/GatewayHttpClient.kt:448-458`；`[U]workbench/WorkbenchScreen.kt:98-102` |
| 回复看门狗 | 20s 无首 token → 拉时间线；120s 仍未完成 → `REPLY_TIMEOUT:NO_REPLY_RECEIVED` | Snackbar + `OUTCOME_UNKNOWN`（若仍 RUNNING 则保持 RUNNING） | `[U]state/WorkbenchController.kt:221-226, 1135-1161` |
| 网络回调 | 默认网络可用时唤醒 owner | 自动重连/刷新 | `[P]GatewayNetworkMonitor.kt:8-40` |

**DSH 结论**：不需要为 App 实现 `/health`；但必须让 `POST /negotiate`、`POST /sessions/password`、`GET /events` 三条链路可用，并保持 SSE 心跳间隔 **小于 20 秒**（App 的读超时是 20s，`[G]http/GatewayTransport.kt:266`）。参考实现按 15s 心跳设计。

### 3.4 超时与重连

| 项目 | 值 | 源码 |
|---|---|---|
| HTTP 连接超时 | 15s | `[G]http/GatewayConnectionFactory.kt:34-37` |
| HTTP 读超时 | 30s | 同上 |
| SSE 空闲超时 | 20s（无字节即判死） | `[G]http/GatewayTransport.kt:266` |
| WebSocket 连接超时 | 10s | `[G]ws/GatewayWebSocketTransport.kt:419` |
| 事件流退避 | 1s, 2s, 5s … 最多 60s | `[G]http/GatewayHttpClient.kt:466-478` |
| 会话恢复退避 | 1s … 60s | `[P]GatewayRuntime.kt:1008-1035` |
| 事件流最大连续失败 | 6 轮 | `[G]http/GatewayHttpClient.kt:86, 448-458` |

---

## 4. 全部界面与功能清单（含网关依赖与降级）

### 4.1 优先级定义

- **P0（MVP 必须）**：不做则 App 无法完成基本连接/对话，或连接后立即出现持续错误。
- **P1（保留主要设计功能）**：App 的主要交互/设计功能，缺失会明确降级；应在第二波实现。
- **P2（完整保留/增强）**：设备插件、邀请/设备密钥、WebSocket、屏幕圈选、通知集成等；可后续实现。
- **—**：本地功能，不需要 DSH 网关工作。

### 4.2 登录、账号与连接

| # | 功能 | 入口界面 | 依赖端点或能力 | 缺失时降级行为 | 优先级 |
|---:|---|---|---|---|---|
| 1 | 网关密码登录 | 登录页“网关地址 / 用户名 / 密码” | `POST /negotiate`、`POST /sessions/password`；响应 refresh credential | 显示 `Failed` + 可读错误；保留在登录页 | P0 |
| 2 | 已保存账号快速选择 | 登录页“已保存账号”列表 | 本地资料；恢复时 `POST /sessions/refresh` | 无保存账号时不显示；刷新失败回登录页 | P0（本地） |
| 3 | 邀请短码登录 | 登录页“使用邀请短码” | `POST /sessions/invite/challenge` → `POST /pairings/exchange`；auth 声明 `account-invitation` | 邀请内容无效/过期时按钮不可用；服务端不支持则认证失败 | P2 |
| 4 | 二维码/深链配对 | 外部扫码 → `oai://pair?…` 深链 | 同上 + `invitationId`/`expiresAt`/`identityFingerprint` | 无内置扫码；粘贴内容不合法则提示 | P2 |
| 5 | 设备密钥登录 | 登录页“使用已配对设备密钥登录”（仅同 URL+用户名已保存时出现） | `POST /sessions/device/challenge` → `POST /sessions/device`；auth 声明 `device-key` | 未保存资料/服务端不支持时失败；不会回退为密码，需用户手动 | P2 |
| 6 | 重新确认网关身份 | 登录失败页按钮 | 本地身份存储；清 refresh/identity | 非 TLS 或无失败时不显示 | P1（本地） |
| 7 | 明文连接警告/传输安全标识 | 登录页、设置页、工作台 | 无网关端点；由 URL scheme + pin 决定 | — | — |
| 8 | 连接阶段/失败重试 | 登录页 PhaseBanner | negotiate/auth 的实际状态 | 失败显示稳定错误文案 + 重试 | P0 |
| 9 | 离线镜像 | 断网/恢复失败后的工作台 | 无；本地加密镜像只读 | 不能发送，提示“重新连接后可发送” | P1（本地） |
| 10 | 自动恢复会话 | 启动时 / 网络恢复 / 回前台 | `POST /negotiate` + `POST /sessions/refresh` | 失败进入离线镜像或重新登录 | P0 |
| 11 | 手动刷新凭据 | 设置 → Gateway 连接详情 → 刷新网关凭据 | `POST /sessions/refresh` | 无 refresh 时提示“请重新登录”；失败保留资料 | P1 |
| 12 | 退出登录 | 抽屉底部“退出登录” | `DELETE /sessions/current?revokeRefresh=true`（签名豁免） | 未确认则不清本机凭据，提示重试 | P1 |
| 13 | 解除设备配对 | 设置 → 危险操作 / 连接详情 | `DELETE /pairings/current`（完整签名 + 精确回执） | 回执不完整则保留本机凭据并提示 | P1 |
| 14 | 移除本机账号 | 登录页“已保存账号 → 移除” | 先 refresh + logout，再本机清理 | 失败保留资料；Gateway 账号不受影响 | P2 |

### 4.3 会话列表与会话管理

| # | 功能 | 入口界面 | 依赖端点或能力 | 缺失时降级行为 | 优先级 |
|---:|---|---|---|---|---|
| 15 | 会话列表/抽屉 | 工作台左侧抽屉；窄屏为 ModalDrawer | `GET /conversations?cursor=&limit=`；会话项含 `conversationId`、`title`、`updatedAt`、`archived` | 加载失败显示“历史会话加载失败，请重试”；空列表显示“暂无历史对话” | P0 |
| 16 | 会话搜索 | 抽屉顶部“搜索会话…” | 无服务端调用；本地 `title.contains(query, ignoreCase)` | 无匹配显示“暂无匹配对话” | — |
| 17 | 新建对话 | 抽屉按钮/顶栏 `+` | `POST /conversations`（`clientConversationId` 幂等） | 失败 `CONVERSATION_CREATE_FAILED:<code>`，保留原会话和草稿 | P0 |
| 18 | `/new` 命令创建 | 用户在输入框手动发 `/new` | 能力 `agent-command-new-v1` + `conversation.command.result` | 未协商：按普通文本发送；不会自动切换；若服务端声明但无结果，App 等待超时并停留原会话 | P2 |
| 19 | 打开会话/首屏 | 点会话行 | `GET /conversations/{id}/messages?cursor=&limit=` | 失败显示时间线错误 + 重试；首屏可能先展示本地镜像 | P0 |
| 20 | 历史分页/快照 | 打开会话自动加载全部页 | 同上；每页返回 `nextCursor`、`snapshotRevision`；变化即 `CURSOR_EXPIRED` 重试 3 次 | 重试仍失败显示 `TIMELINE_RESYNC_FAILED`/错误；不会混用不同快照 | P1 |
| 21 | 重命名对话 | 顶栏编辑按钮；抽屉行菜单“重命名对话” | `PATCH /conversations/{id}` body `{title}` | 保存失败回退标题（顶栏仍可用）；抽屉菜单在未协商 management 时禁用（App 不一致） | P1 |
| 22 | 归档/取消归档 | 抽屉行菜单 | `PATCH /conversations/{id}` body `{archived}` + 能力 `conversation-management-v1` | 未协商：菜单项禁用，提示“此 Gateway 暂不支持会话管理” | P1 |
| 23 | 删除对话 | 抽屉行菜单 → 确认 | `DELETE /conversations/{id}` + management | 未协商：菜单项禁用；`CONVERSATION_BUSY` 时提示任务未结束 | P1 |
| 24 | 文件夹管理 | 抽屉“管理文件夹” | `GET/PUT /conversation-organization` + management | 未协商：按钮禁用/提示不支持 | P1 |
| 25 | 会话归类 | 行菜单“移动到文件夹” | 同上（`assignments`） | 未协商：菜单项禁用；无文件夹时提示先新建 | P1 |
| 26 | 排序/拖动 | 抽屉排序菜单 + 长按拖动 | 同上（`sortMode`、`customOrder`） | 未协商：排序按钮禁用，提示“长按会话并拖动…”不可用 | P1 |
| 27 | 会话变更实时刷新 | 无独立界面 | 事件 `conversation.updated`、`conversation.deleted`、`conversation.organization.updated`、`conversation.title.updated` | 缺失：列表/标题只在重连、回前台、手动刷新、操作后更新 | P1 |
| 28 | 自动标题 | 首条消息后自动生成 | `PATCH /conversations/{id}`（本地生成标题） | 保存失败回退原标题；用户手动重命名后不再覆盖 | P1 |
| 29 | 附件库（历史媒体） | 顶栏回形针 / 抽屉“附件库” | 当前草稿 + 历史媒体下载（见 4.5） | 草稿为空显示“还没有选择附件”；历史为空显示“暂无历史媒体” | P1 |

### 4.4 消息、流式与生成

| # | 功能 | 入口界面 | 依赖端点或能力 | 缺失时降级行为 | 优先级 |
|---:|---|---|---|---|---|
| 30 | 发送文本 | 底部输入栏发送按钮 | `POST /conversations/{id}/messages`；body `clientMessageId` + `text` + `attachments`；响应 `{message:{status:"accepted",messageId,conversationId,generationId?}}` | 失败先按 `clientMessageId` 查询；仍未知则 `SEND_OUTCOME_UNKNOWN`，要求“确认并查询未确认消息” | P0 |
| 31 | 首条消息自动建会话 | 没有活动会话时直接输入并发送 | `POST /conversations`（本地生成 `cconv_`） | 创建失败保留草稿；不会在旧会话里硬发 | P0 |
| 32 | 消息防抖/合并发送 | 设置 → 消息防抖；输入多条后等待 | 能力 `message-batches-v1` + `newline-v1`；`POST /conversations/{id}/message-batches` | 未协商：每条立即发送；防抖设置仍显示但不生效（App 不一致） | P1 |
| 33 | 发送状态点 | 用户消息气泡右下角 | 事件 `conversation.message.status`（`queued/delivered/completed/failed` + `revision` + `errorCode`） | 缺失：状态点不出现或停在“等待 Gateway 接收”；不会伪造完成 | P1 |
| 34 | 流式输出 | 助手消息正文 + 流式光标 | 事件 `conversation.message.delta`；`parts`/`text` + `messageId` + `conversationId` + `revision` + `generationId?` | 缺失：无增量文本；回复看门狗 20s 后拉时间线，120s 报超时 | P0 |
| 35 | 思考内容 | 助手消息里的思考卡 | 文本标记 `<think>…</think>`（无协议字段） | 没有标记：按普通 Markdown 显示；不折叠 | P1 |
| 36 | 工具调用卡 | 助手消息里的工具卡 | 文本标记 `<tool_call name="…">…</tool_call>`（无协议字段） | 没有标记：按普通文本/代码块显示；无工具名、参数、输出卡 | P1 |
| 37 | 停止生成 | 输入栏的停止按钮（运行中且无待发输入时出现） | 能力 `generation-cancel-v1`；`GET /generations/current`；`POST /generations/{gid}/cancel` | 未协商：按钮仍显示，按下后 `GenerationState.UNSUPPORTED` → “当前 Gateway 不支持停止生成”；无 generationId 时 `STOP_UNAVAILABLE:NO_GENERATION` | P1 |
| 38 | 回复超时提示 | Snackbar + 生成状态 | 本地看门狗；20s/120s | — | — |
| 39 | 直播通道断开提示 | 工作台顶部/Snackbar | SSE 状态 | `FAILED` 时提示并停止重试 | P0 |
| 40 | 回到最新 | 列表底部浮动按钮 | — | — | — |
| 41 | 复制/选择文本 | 消息内容 | — | — | — |

### 4.5 附件、图片、语音与媒体

| # | 功能 | 入口界面 | 依赖端点或能力 | 缺失时降级行为 | 优先级 |
|---:|---|---|---|---|---|
| 42 | 拍照/相册/文档选择 | 输入栏 `+` → 底部弹窗；附件库 | 系统 Camera/Photo Picker/SAF；无网关 | 权限/取消时提示；不静默读盘 | — |
| 43 | 附件上传三步 | 选择后立即暂存并上传 | `POST /attachments` → `GET /attachments/{id}` → `PUT /attachments/{id}/content` → `POST /attachments/{id}/commit` | 失败按阶段提示；`GET` 状态缺失会 `ATTACHMENT_STATUS_UNKNOWN`；未 verified 不允许发送 | P0 |
| 44 | 发送附件 | 附件草稿胶囊 + 发送 | `POST /messages` 带 `attachments:[{attachmentId}]` | 附件未核验/上传失败时阻止发送并提示重试 | P0 |
| 45 | 消息内图片/文件展示 | 用户/助手消息气泡内的附件卡 | 消息 `parts` 的 attachment 引用；历史媒体 `metadata`/`cache-grant`/`content` | 无本地预览显示文件卡片；原件不可用显示“原件不可用，附件信息仍保留” | P1 |
| 46 | 图片预览 | 附件卡内 240dp 高预览 | 本地字节或历史媒体内容 | 无内容时只显示文件名/图标 | P1 |
| 47 | 下载到系统下载目录 | 附件卡“下载” | 历史媒体 `content?format=stream-v1`（或旧 JSON/base64） | 原件不可用时按钮禁用；失败显示“下载失败，请重试” | P1 |
| 48 | 语音输入 | 输入栏麦克风 | 本地 `MediaRecorder` 生成 `audio/mp4`，走附件链路 | 麦克风权限失败提示；录音为空/失败不发送 | P1 |
| 49 | 屏幕圈选 | 浮动助理面板的圈选 | 本地 MediaProjection → PNG 附件；**不需要单独网关端点** | 截图来源未授权/失败时圈选层显示不可用；设置页条目因 `attachment-status-v1` 永不协商而显示不可用（App 侧问题） | P2 |
| 50 | 附件本地加密暂存/恢复 | 后台恢复 | 无网关；本地 staging | 中断后恢复上传/查询原 `clientAttachmentId` | P1（本地） |

### 4.6 斜杠命令

| # | 功能 | 入口界面 | 依赖端点或能力 | 缺失时降级行为 | 优先级 |
|---:|---|---|---|---|---|
| 51 | 命令目录加载 | 工作台初始化时自动；输入 `/` 时展示 | `GET /commands?languageCode=<bcp47>`；响应 `format/catalogVersion/languageCode/commands[]` | 失败：命令面板显示“无法加载 Agent 命令目录（code）”；用户仍可原样发送 `/xxx` | P1 |
| 52 | 命令前缀筛选 | 输入 `/` 后 | 本地 `startsWith(prefix, ignoreCase)` | 无匹配显示“回车可原样发送” | — |
| 53 | 命令项展示 | 命令弹窗 | `invocation`（等宽）、`argumentHint`、`description` | 缺 `argumentHint` 不显示；`description` 为空时回退 `title` | P1 |
| 54 | 未列出命令原样发送 | 输入框 | 无 | 始终允许；命令解释由 Agent 负责 | — |

**重要**：`WorkbenchController` 在初始化时**无条件**调用 `loadCatalog()`（`[U]state/WorkbenchController.kt:1062`），并不检查 `agent-command-catalog-v1` 是否协商成功。因此 `/commands` 端点实际上是“总是会被请求”的；能力位只影响设置页三态显示，不决定是否请求。DSH 应实现该端点，哪怕不声明能力位。

### 4.7 审批卡片

| # | 功能 | 入口界面 | 依赖端点或能力 | 缺失时降级行为 | 优先级 |
|---:|---|---|---|---|---|
| 55 | 命令执行审批卡 | 对话流中的独立卡片 | 能力 `agent-approval-cards-v1`；事件 `conversation.approval.requested` / `resolved`；`POST /approvals/{id}/decisions` | 未声明：不画卡；输入栏上方显示可关闭提示“该网关不支持审批卡片，请用 /approve 文本命令回复。” | P1 |
| 56 | 审批档位/倒计时 | 卡片内按钮 + 倒计时 | 事件 `options[]`（`choice/label/style`）、`timeoutSeconds`、`requestedAt`、`expiresAt` | 无 `options` 不画卡；未知 `choice` 被丢弃；倒计时到 0 只禁用本地按钮，终态仍由 Gateway 事件决定 | P1 |
| 57 | 决策提交反馈 | 卡片按钮 | `POST /approvals/{id}/decisions`；成功 `{approval:{approvalId,conversationId,decision,decidedAt}}`；409 `APPROVAL_ALREADY_RESOLVED`/`APPROVAL_EXPIRED` | 失败恢复可点击 + 结构化提示；未收到 `resolved` 前不显示“已允许” | P1 |
| 58 | 审批审计 | 设置 → 安全审计流水 | 本地 platform-kernel 审计；决策被接受时写 `approval.user.confirmed.<decision>.<outcome>` | 无网关依赖 | — |

### 4.8 设备能力、通知、短信、通话记录

| # | 功能 | 入口界面 | 依赖端点或能力 | 缺失时降级行为 | 优先级 |
|---:|---|---|---|---|---|
| 59 | 插件安装/启用/授权 | 设置 → 插件管理 | 本地 `.alp`、平台内核；能力同步 `GET /pairings/current`、`POST /pairings/current/capabilities` | 未连接：授权不可用；同步失败显示“Gateway 能力同步失败，正在重试” | P1（会话不受影响） |
| 60 | 设备请求执行 | 无独立界面；由事件触发 | `device.requested` 事件；`GET /device-requests/{id}`；`POST /device-requests/{id}/claim`；`POST /device-requests/{id}/result` | DSH 不下发请求则不触发；缺 GET 详情会失败；缺 claim/result 无法交付 | P2 |
| 61 | 人工确认设备操作 | 系统对话框“确认设备操作” | 本地；写/高权限请求必须前台确认 | 前台确认超时/拒绝 → `denied`；不会后台静默执行 | P2 |
| 62 | 通知读取（设备插件） | 设置 → 通知采集设置 | 设备请求 + 通知插件；`GET/POST /pairings/current*` | 未安装/未启用/未授权时拒绝读取；无网关专用端点 | P2 |
| 63 | 短信读取 | 设置 → 设备能力 → 短信读取（跳插件管理） | 设备请求 + SMS 插件（`org.openandroidintelligence.sms.query`） | 未授权/未安装提示；无独立短信界面 | P2 |
| 64 | 短信发送/计划（插件） | 无 App 界面；Agent 发起设备请求 | SMS 插件 `schedule/job-status/cancel` + 人工确认 | 未授权/未确认 → 拒绝；DSH 必须走设备请求，不能直连系统 API | P2 |
| 65 | 通话记录（插件） | 无 App 界面；Agent 发起设备请求 | `org.openandroidintelligence.call-log.query` | 未授权/未安装拒绝 | P2 |
| 66 | 通知回复（会话通知） | 系统通知/通知抽屉 | 本地通知 + SSE 事件；终态用户消息 status | 无流式事件则不更新；权限拒绝则不显示 | P1（依赖事件） |
| 67 | 会话气泡 | 系统 Bubble | 本地；`BubbleConversationActivity` + 同一控制器 | 系统不允许气泡时普通通知仍可用 | — |
| 68 | Android 16 Live Updates | 系统实时活动 | 本地 `LiveUpdateNotifications` + 生成状态 | 不支持/未允许时回退普通通知 | — |

**通知没有“网关订阅/查询”端点。** App 侧分两条路：① 读取其他应用通知 = 设备插件 + `device.requested` 设备请求；② 本 App 的 Agent 回复通知/气泡/Live Updates = 本地系统通知，数据来自 SSE 事件。不要为通知设计独立的网关订阅路由。

### 4.9 设置、诊断与安全

| # | 功能 | 入口界面 | 依赖端点或能力 | 缺失时降级行为 | 优先级 |
|---:|---|---|---|---|---|
| 69 | 外观/主题/动态取色/减弱动效 | 设置 → 外观与动效 | 无 | — | — |
| 70 | Gateway 连接详情 | 设置 → Gateway 连接管理 | 本地 phase/username/url/transport/pairingSummary | 未连接显示“未登录/未连接” | — |
| 71 | 协商能力三态 | 设置 → Gateway 连接详情 | `features.conversationUi` 的 9 键闭集 | 缺键显示“未声明”；明确未同意显示“本网关不支持”；同意显示“已启用” | P1（本地展示） |
| 72 | 传输安全拓扑 | 设置 → 概览/连接详情 | 无；由 scheme + pin 决定 | — | — |
| 73 | 配对摘要 | 设置 → 连接详情 | 登录响应 `pairingSummary`（App 只读字符串） | 未提供显示“Gateway 未提供配对摘要” | P2（可选） |
| 74 | 设备请求执行通路 | 设置 → 连接详情 | `features.deviceRequests` | 未提供显示“Gateway 未提供设备请求”；提供但插件链未接显示“本机插件执行链尚未接通” | P2 |
| 75 | 消息防抖设置 | 设置 → 消息防抖 | 本地偏好；只有 batches 协商后才生效 | 未协商时设置无效但不报错（App 不一致） | P1 |
| 76 | 运行安全模式/内核策略/插件管理 | 设置 | 本地 platform-kernel | — | — |
| 77 | 安全审计日志 | 设置 → 内核安全审计流水 | 本地不可篡改审计链 | — | — |
| 78 | 一键熔断/解除配对 | 设置 → 危险操作 | 本地 + `DELETE /pairings/current` | 未连接时解除配对不显示 | P1（解绑端点） |
| 79 | 连接诊断/日志 | 无独立页面 | `GatewayLog` 写 logcat；debug 下输出协议证据 | 无网关诊断端点；用户只能看错误文案 | — |

### 4.10 明确“不存在”的功能（不要为它们设计网关）

| 功能 | App 是否有入口 | 结论 | 证据 |
|---|---|---|---|
| 模型选择/模型名显示 | 无 | 没有 `/models` 调用、没有模型选择 UI；模型由 Agent 宿主决定 | 全仓 Kotlin 中 `modelId` / `modelName` / `"/models"` 无读取；`[G]`/`[P]`/`[U]` 检索为空 |
| 重新生成/继续生成 | 无 | 只有“发送失败重试”和“附件上传重试”；没有 regenerate/continue 按钮 | `[U]state/WorkbenchController.kt:2149-2218, 2659-2806`；`[U]workbench/ComposerBar.kt:335-420` |
| 服务端全文搜索 | 无 | 抽屉搜索只在本地按会话标题过滤，不调用网关 | `[U]workbench/ConversationBrowser.kt:116, 135-142` |
| 共享文件夹 | 无 | 没有该概念；“附件库”是最接近的历史媒体/草稿界面 | `[U]workbench/AttachmentLibraryScreen.kt` |
| 内置二维码扫描 | 无 | 只接受粘贴的 `oai://pair?…` 或外部深链；没有相机扫码 | `[P]GatewayLoginScreen.kt:77-93, 219-227` |
| 独立诊断/日志页 | 无 | 只有 logcat 的 `GatewayLog`；设置页“审计”是本地内核审计，不是网关诊断 | `[P]SettingsScreen.kt:1235-1296` |
| 结构化工具调用/思考字段 | 无 | 名称、参数、输出都是助手正文文本；协议没有 tool/thought 消息类型 | `[U]workbench/markdown/MarkdownParser.kt:12-13, 276-339` |

---

## 5. 能力位矩阵：协商到与没协商到的真实差异

### 5.1 客户端 offer 与三种状态

客户端在协商请求里声明 7 个 `conversationUi` 键（`[G]negotiation/NegotiationClient.kt:21-29`），设置页按 9 键闭集展示（`[P]ConversationUiCapabilities.kt:10-23`）。三态定义：

- `true` = 协商交集（客户端声明且网关同意）。
- `false` = 客户端声明过，但网关没同意。
- `null` = 双方都没声明（或客户端根本没声明，比如 `conversation-mirror-v1`、`attachment-status-v1`）。

展示文案固定为“已启用 / 本网关不支持 / 未声明”（`[P]ConversationUiCapabilities.kt:50-54`；`[P]SettingsCapabilityUi.kt:211-229`）。

### 5.2 各能力位对 App 的真实影响

| 能力位 | 真正控制的 App 行为 | 网关缺失时的降级 | 是否为 DSH MVP 必需 |
|---|---|---|---|
| `agent-command-catalog-v1` | 只影响设置页三态；`/commands` 仍会被无条件请求 | 命令面板在请求失败时显示错误；命令仍可原样发送 | 建议实现（端点简单） |
| `agent-command-new-v1` | 手动输入 `/new` 时，是否等待 `conversation.command.result` 并切换会话 | 按普通文本发送，不自动切换 | 否 |
| `agent-approval-cards-v1` | 是否创建 `ApprovalClient`、是否画卡、是否显示“不支持”提示 | 不画卡；文本提示 | 否（但会显示提示条） |
| `message-batches-v1` + `newline-v1` | 是否把连续文本合并为 `/message-batches` | 每条单独 `POST /messages` | 否 |
| `generation-cancel-v1` | 是否启用 `/generations/current` 与 cancel 请求 | 停止按钮返回 `UNSUPPORTED`，不发送请求 | 否（建议 P1） |
| `conversation-management-v1` | 是否启用 organization/归档/删除；列表分页含归档 | 归档/文件夹/排序/删除禁用；`GET /conversations` 仍可用 | 否 |
| `conversation-mirror-v1` | **App 不声明，永不协商**；本地加密镜像不依赖它 | 无影响 | 否（不要返回） |
| `attachment-status-v1` | 只影响设置页“屏幕圈选”条目的可用性；**`GET /attachments/{id}` 不受它控制** | 设置页条目显示“未声明”；上传流程仍调用状态端点 | 否（不要返回） |

**关键陷阱**：`DECLARED_CONVERSATION_UI_FEATURES`（7 键）、`ConversationUiFeature.CLOSED_SET`（9 键）、`CLIENT_CONVERSATION_UI_OFFER`（6 键，缺 `newline-v1`）是**三份不同的列表**。功能门禁用的是协商原始 `conversationUi` 列表或 7 键交集，设置页展示用的是 6 键 × 9 键，所以 `newline-v1` 在设置页永远显示“未声明”，即使网关同意。详见 §8.2。

---

## 6. 宿主私有扩展与 App 的硬依赖

### 6.1 App 会调用、但最容易漏掉或只在参考实现里出现的端点

> 第 1–6 行不在契约正文（属“App 事实标准 + 参考实现”扩展）；第 7–8 行在契约中定义，但实现时常被漏掉，且宿主支持并不一致。

| # | 端点 | App 使用场景 | App 读取的关键字段 | 缺失后果 | 参考宿主 |
|---:|---|---|---|---|---|
| 1 | `POST /sessions/invite/challenge` | 邀请短码登录 | `data` 恰好 7 字段：`challengeId/accountId/negotiationId/installationId/devicePublicKey/nonce/expiresAt` | 邀请登录失败 | Hermes/OpenClaw 均实现 |
| 2 | `POST /sessions/device/challenge` | 设备密钥登录 | `data` 恰好 7 字段：`challenge/accountId/negotiationId/installationId/deviceId/nonce/expiresAt` | 设备密钥登录失败 | 均实现 |
| 3 | `GET /pairings/current` | 每次连接后由 `CapabilityPublisher` 每 5s 调用 | `grantRevision`、可选 `grantDigest`、`capabilityPolicy`、`capabilities[]`、`capabilityPublicationVersion` | **持续提示“设备能力授权同步失败，正在重试”**；不影响聊天 | 均实现 |
| 4 | `POST /pairings/current/capabilities` | 发布本机插件授权/能力清单 | 响应 `grantRevision` + `grantDigest`（必须与 App 计算的 JCS 摘要一致） | 设备插件无法在 Gateway 侧授权；可能出现 `CAPABILITY_DIGEST_MISMATCH` 重试 | 均实现 |
| 5 | `GET /device-requests/{id}` | 收到 `device.requested` 后取权威详情 | `data.request`，含 `state/deviceId/pairingGeneration/grantRevision/expiresAt/capability/provider/parameters/risk/requiresForegroundConfirmation` | 设备请求无法执行 | 均实现 |
| 6 | `GET /sync/snapshot` | SSE 游标过期（`CURSOR_EXPIRED`）时重建基线 | `baselineCursor`（wire ID）、`pendingDeviceRequests[]`；`conversations` 字段 App 在该路径不使用 | 事件流无法恢复，只能重新登录/重连；平台事件通道 FAILED | 均实现 |
| 7 | `GET /events/ws` | 事件流首选 WebSocket | `101` + 文本帧 `{id,event,data}` | 自动降级 SSE（会先浪费一次握手） | 本快照两者均未实现；App 仍会先试 |
| 8 | `POST /approvals/{id}/decisions` | 审批卡决策 | 成功 `data.approval.{approvalId,conversationId,decision,decidedAt}`；409 `error.details.decision` | 审批卡不可用（前提是声明了能力） | Hermes 实现；OpenClaw 固定版未实现 |

> 设备详情响应的形状警告：App 只读取 `data.request`（`[P]plugins/DeviceExecutionDriver.kt:34-36`）。参考实现 Hermes 的同一路径在不同分支分别返回过 `{"request": …}` 与 `{"deviceRequest": …}`（`hermes.../core.py:5537` 与 `:5697`）；DSH 必须以 App 的 `request` 为准，不能照抄 `deviceRequest`。

### 6.2 哪些是“App 硬依赖”，哪些只是“可选能力”

| 项目 | 是否 App 硬依赖 | 说明 |
|---|---|---|
| `messageBatches` | 否 | 未协商时单条发送；App 有完整降级路径 |
| `approvalCards` | 否 | 未协商时不画卡并提示 |
| `mirrorSync` | **否，且 App 不声明** | `conversation-mirror-v1` 永不在 offer 里；本地镜像不使用服务端 mirrorSync。返回该能力反而会让协商失败 |
| `invitationPairing` | 仅邀请登录硬依赖 | 密码登录不需要；但 App 的邀请入口始终显示，服务端不支持会认证失败 |
| `deviceKeySessions` | 仅设备密钥登录硬依赖 | 密码 + refresh 即可满足 MVP |
| `conversation-management` | 否 | 归档/文件夹/排序/删除降级为禁用 |
| `generation-cancel` | 否 | 停止按钮降级为 `UNSUPPORTED` |
| `agent-command-new` | 否 | `/new` 降级为普通文本 |
| `attachment-status-v1` | **名不副实** | App 永不声明该能力，但上传流程始终调用 `GET /attachments/{id}`；所以状态端点是硬依赖，能力位不是 |
| `message-batches` 的 `newline-v1` | 与 `message-batches-v1` 同时 | App 的 `messageBatchesAgreed` 要求两者都在交集中；只回一个不会启用批处理 |
| `/sync/snapshot` | 条件硬依赖 | 只在游标过期时；如果 DSH 事件保留足够长且不主动使游标失效，可以暂时不实现，但长期不可靠 |
| `/pairings/current` | **是（生产装配下）** | `pluginHost` 非空时登录后无条件轮询；缺失会持续报错（虽然聊天仍可用） |

### 6.3 App 消费的事件类型

App 的 `GatewayEventDecoder` 接受的事件（包含契约正文和参考宿主扩展）：

| 事件 | App 用途 | 关键字段 | 是否契约正文 | 优先级 |
|---|---|---|---|---|
| `conversation.message.delta` | 流式助手正文 | `conversationId`、`messageId`、`parts`/`text`、`revision`、`sender`、`generationId?`、`timestamp?` | 是 | P0 |
| `conversation.message.completed` | 助手消息完成 | 同上，state 固定 CONFIRMED | 是 | P0 |
| `conversation.message.status` | 用户消息状态/终态 | `conversationId`、`messageId`、`clientMessageId`、`status`、`revision`、`errorCode`（失败必填，其余必须 null）、`generationId?` | 是 | P0 |
| `conversation.command.result` | `/new` 结果 | `command`、`outcome`、`sourceConversationId`、`sourceMessageId`、`conversationId?` | 是（`agent-command-new-v1`） | P2 |
| `conversation.approval.requested` | 画审批卡 | `approvalId`、`conversationId`、`command`、`reason`、`severity`、`options[]`、`timeoutSeconds`、`requestedAt`、`expiresAt` | 是（`agent-approval-cards-v1`） | P1 |
| `conversation.approval.resolved` | 结算卡片 | `approvalId`、`decision`（含 timeout/withdrawn）、`decidedAt` | 是 | P1 |
| `conversation.title.updated` | 标题同步 | `conversationId`、`title`/`newTitle` | 是 | P1 |
| `conversation.updated` | 会话列表/归档状态刷新 | `conversationId`、`archived`/`deleted` | 是（§7 管理） | P1 |
| `conversation.deleted` | 删除同步 | `conversationId` | 参考实现扩展/旧版 | P1 |
| `conversation.organization.updated` | 文件夹/排序刷新 | `revision` | 是（§7 管理） | P1 |
| `conversation.snapshot.invalidated` | 主动重建时间线 | `snapshotRevision`、`conversationId?` | 参考实现扩展 | P2 |
| `conversation.generation.cancelled` | 取消终态/通知 | `generationId`、`conversationId?` | 参考实现扩展（不在 event schema 枚举） | P1（若实现停止） |
| `conversation.timeline.upsert/tombstoned` | 旧版兼容 | `messageId`、`revision` | 旧版 | P2 |
| `conversation.message.accepted` | 旧版兼容 | `messageId`、`correlationId` | 旧版 | P2 |
| `device.requested` | 设备请求唤醒 | `requestId`（其余从 GET 详情取） | 是 | P2 |
| `device.request.cancel.requested` | 取消意图 | `requestId` | 是 | P2 |
| `session.revoked` | 当前会话被撤销 | `sessionId` | 是 | P1 |
| `pairing.grant.changed` | 授权修订变化 | `grantRevision`、`deviceId`、`grantDigest?` | 是 | P2 |
| `attachment.acknowledged` | **App 不处理（忽略）** | `attachmentId` | 是 | — |
| `gateway.notice` | **App 不处理（忽略）**；宿主可用作基线事件 | 任意 | 是 | — |

**事件投递要求**：

- 帧格式必须是 SSE：`id:`、`event:`、`data:`，空行结束；`data` 是 JSON 字符串（`[G]events/SseParser.kt:124-166`）。
- 事件 ID 同时是游标，必须符合 wire ID `[A-Za-z0-9._~-]{1,128}`；App 只接受这个字母表的游标（`[G]http/GatewayHttpClient.kt:525-526, 306`）。
- 必须“提交后立即投递”，不能只落库等下一次订阅；App 的实时体验依赖它（契约 §9）。
- 重放必须幂等：App 会按 event id 去重（最近 4096 个），但游标写入在事件成功交付后（`[G]http/GatewayHttpClient.kt:160-205`）。
- `GET /events` 必须返回 `Content-Type: text/event-stream`；返回 JSON `{events:[…]}` 不会被 App 的流读取器接受（`[G]http/GatewayTransport.kt:173-176`）。
- 无事件时发送注释心跳 `: ping`（或任意完整帧），间隔 < 20s。

---

## 7. 展示要求：主机名、身份、模型名、命令、工具

### 7.1 主机名 / 地址 / 账号

| 位置 | 展示内容 | 格式规则 | 源码 |
|---|---|---|---|
| 登录页 | 网关地址输入框 | placeholder `https://gateway.example.local:8443` 或 `http://10.0.2.2:8045` | `[P]GatewayLoginScreen.kt:244` |
| 工作台顶栏 | `gatewayLabel.removePrefix("https://")` + ` · ` + 连接状态 | 只去掉 `https://`，`http://` 会原样显示；超长 ellipsis | `[U]workbench/WorkbenchScreen.kt:200-224` |
| 抽屉账号区 | 用户名（`@` 前部分）+ 网关地址（去掉 `https://`）+ 在线/离线点 | 用户名取 `gatewayLabel` 的 `@` 前缀；没有 `@` 显示“用户” | `[U]workbench/ThreadDrawer.kt:65, 160-192` |
| 设置连接详情 | 账号主体、Gateway 节点地址、传输安全、配对摘要 | 完整 URL；明文/固定/系统 CA 三态；摘要缺省时明确写“Gateway 未提供配对摘要” | `[P]SettingsScreen.kt:875-940` |

**没有显示 `deploymentId`。** 身份只在 TLS pin / 设置页“传输安全”里体现；`deploymentId` 只用于本地身份比对和邀请指纹校验。

### 7.2 模型名 / 模型选择

**App 没有模型选择，也不显示模型名。** `conversation-ui`、`app`、`gateway-client` 中没有任何 `/models`、`modelId`、`modelName` 的读取或 UI（全仓 grep 为空）。助手消息只显示“AI 助手/对话标题”和正文；设置页没有模型项。

因此：

- DSH 不需要为 App 实现模型列表、模型切换、模型标签。
- 模型由 Agent 宿主内部决定；客户端只关心消息文本和生成状态。
- 如果 DSH 想在 App 里体现模型名，只能写进消息正文或标题，不属于协议功能。

### 7.3 命令目录展示

命令项的数据源是 `GET /commands` 的 `commands[]`，App 实际使用：

| 字段 | 用途 | 缺省行为 |
|---|---|---|
| `invocation` | 等宽显示，选中后填入输入框；没有 `/` 会补 `/` | 缺失则丢弃该条 |
| `argumentHint` | 显示在命令名后的提示 | 缺失不显示 |
| `description` | 右侧描述 | 为空时回退 `title` |
| `title` | 仅作为 `description` 的回退 | 缺失则描述为空 |
| `id` | 仅作为回退（`invocation` 去 `/`） | 缺失则用 invocation |
| `availability` | **App 不读取/不筛除** | 所有条目都显示 |

源码：`[G]commands/CommandCatalogClient.kt:38-105`；`[D]GatewayConversationRepository.kt:516-533`；`[U]workbench/CommandMenu.kt:213-265`。

**结论**：DSH 应把用户可读文案放在 `description`，并尽量提供 `argumentHint`；`availability` 即使写 `unavailable` 也不会被 App 隐藏，所以不要用它表达不可用。

### 7.4 思考内容与工具调用

两者都是**助手正文的文本标记**，不是协议结构化字段：

| 展示 | 文本标记 | 渲染结果 | 源码 |
|---|---|---|---|
| 思考卡 | `<think>…</think>` | 流式中自动展开、显示“AI 正在思考”+跳动点+光标；闭合后折叠为“已折叠思考过程 · 共 N 字 · 点击展开”；用户手动展开/收起优先 | `[U]workbench/markdown/MarkdownParser.kt:12-13, 45-83`；`[U]workbench/markdown/MarkdownThoughtView.kt:37-160` |
| 工具卡 | `<tool_call name="…">…</tool_call>`，内部可含 `<tool_name>`、`<command>`/`<cmd>`、`<result status="…">`、`<output>`、`<summary>`、`<error>` | 等宽 `[工具名]` Badge；命令内容可复制；成功/失败状态条；输出可折叠 | `[U]workbench/markdown/MarkdownParser.kt:276-339`；`[U]workbench/markdown/MarkdownToolCallView.kt:73-220` |

工具名规则：

- `name` 属性为空、等于 `tool_call`、或等于“执行命令” → 显示 `[执行命令]`。
- 以 `[`/`]` 包裹的 name 原样显示；否则显示 `[name]`。
- 没有按工具类型区分的图标；只有统一卡片和等宽文字。

**结论**：DSH 若想保留“思考/工具调用可视化”，需要在助手消息文本里按上述 XML 标记序列化；否则 App 只会当普通 Markdown 渲染。这是 DSH 侧的**内容格式选择**，不是网关协议字段。

### 7.5 消息状态与身份展示

- 用户消息右下角：`发送失败 · <code>` / 状态点 + `messageStatusLabel` / “等待 Gateway 接收”/“等待合并”/时间。
- 助手消息：`OaiMessage:<key>:streaming|completed` 的 accessibility 描述（测试/无障碍用）。
- 审批卡/工具卡/思考卡各有独立 testTag，但用户可见文案是中文固定文案。

源码：`[U]workbench/MessageTimeline.kt:195-395`；`[U]workbench/ApprovalCard.kt:75-260`。

---

## 8. 契约冻结、App 缺陷与扩展点

### 8.1 绝对不能改的 App 侧契约

以下内容是 App **硬编码**的；DSH 只能适配，不能要求 App 先改：

| 类别 | 固定内容 | 源码 |
|---|---|---|
| 基路径 | `/open-android-intelligence/v2` | `[G]http/CanonicalTarget.kt:19`；各 Client |
| 协议版本 | envelope `"2.1"`；协商 major=2、minor=1 | `[G]negotiation/NegotiationClient.kt:220-222`；`[G]http/GatewayResponseData.kt:15-16` |
| 核心摘要 | 七个 Schema 文件的固定算法与顺序；当前常量 `sha256:032f…4d23` | `[G]schema/SchemaContractHash.kt:17-47` |
| 请求签名 | 九个 header、canonical target、10 行 preimage、body SHA-256 | 契约 §6；`[G]http/RequestSigner.kt`、`CanonicalTarget.kt`、`GatewayHttpClient.kt:557-575` |
| 幂等键 | 已认证变更请求的 `Idempotency-Key` 必须逐字节等于 `X-Open-Android-Intelligence-Request-Id` | `[G]http/GatewayHttpClient.kt:572-574` |
| 响应信封 | 成功必须 `protocol:"2.1"` + `data`；错误必须 `error.code/retryable` | `[G]http/GatewayResponseData.kt:8-20`；`[G]auth/GatewayAuthClient.kt:201-221` |
| 事件流 | SSE `id/event/data`、`Content-Type: text/event-stream`、`?cursor=`、410=`CURSOR_EXPIRED`、401=session rejected | `[G]http/GatewayTransport.kt:157-190`；`[G]events/SseParser.kt` |
| 消息形状 | `sender == "user"` 判用户；其余为助手；`state == "STREAMING"/"CONFIRMED"`；`parts[].type` 为 `text`/`attachment(_ref)` | `[U]state/WorkbenchController.kt:1297, 3335, 3767`；`[G]conversations/ConversationClient.kt:602-629` |
| 流式语义 | `delta` 是**完整正文覆盖**（`parts`/`text`），不是增量拼接；`revision` 必须随内容递增 | `[D]GatewayEventDecoder.kt:290-308`；`[U]state/WorkbenchController.kt:3273-3345` |
| 生成终态 | 只有用户消息 `status` 的终态、取消确认或权威 current-generation 查询能结束生成；助手 completed 只结束该消息 | 契约 §7；`[U]state/WorkbenchController.kt:3237-3270` |
| 附件 | 三步 create→status→upload→commit；`PUT` 必须带 `Content-Type`/`Content-Length`/`Digest`；状态字段 `attachmentId/status/sizeBytes/sha256` | `[G]attachments/AttachmentUploader.kt:90-145`；`[G]attachments/HttpAttachmentTransport.kt:48-125` |
| 历史媒体 | `metadata?format=stream-v1`、`cache-grant`、`content`；grantId 为 43 位 base64url；流响应必须带 `X-Open-Android-Intelligence-Media-Format: stream-v1` 和匹配的 `Content-Type` | `[P]conversations/EncryptedHistoryMediaCache.kt:109-133, 180-205` |
| 审批 | 事件字段、四档 `choice` 闭集、决策端点响应形状、409 语义 | 契约 §7.2；`[G]approvals/ApprovalClient.kt:102-190` |
| 绑定/解绑回执 | 解绑 `data` 恰好 `deviceId` + 六个 `true` 布尔 | `[G]auth/PairingRevocationClient.kt:10-30` |
| 设备请求 | claim 回执六字段；result body `{claimId, grantRevision, result:{outcome,data?}}`；详情 `data.request` | `[G]device/HttpDeviceRequestTransport.kt:31-90`；`[P]plugins/DeviceExecutionDriver.kt:32-160` |
| 命令目录 | `format/catalogVersion/languageCode/commands[]`；`invocation` 可带或不带 `/` | `[G]commands/CommandCatalogClient.kt:38-105` |

### 8.2 App 自身的 bug / 不一致（可在 App 修，不应让网关迁就）

| # | 现象 | 影响 | 证据 |
|---:|---|---|---|
| A1 | `CLIENT_CONVERSATION_UI_OFFER` 只有 6 键，缺 `newline-v1`，而 `NegotiationClient` 声明 7 键 | 设置页 `newline-v1` 永远显示“未声明”，即使协商成功；`Connected.conversationUi` 也会滤掉它 | `[P]GatewayRuntime.kt:95-102` vs `[G]negotiation/NegotiationClient.kt:21-29` |
| A2 | 抽屉“重命名对话”菜单项受 `conversation-management-v1` 门禁，但顶栏重命名不受门禁，且 `PATCH /conversations/{id}` 改名不需要该能力 | 未协商 management 的网关，用户从顶栏能改名、从抽屉菜单不能；UI 不一致 | `[U]workbench/ConversationBrowser.kt:453-458`；`[U]state/WorkbenchController.kt:770-800` |
| A3 | “消息防抖”设置项始终显示，未检查 `message-batches-v1` | 未协商 batches 时调整滑块没有任何效果；用户会以为防抖生效 | `[P]SettingsScreen.kt:448-480`；`[U]state/WorkbenchController.kt:2374` |
| A4 | `ConversationUiCapabilities` 的注释说截图/推送“当前恒为 false”，但 `SettingsCapabilityUi` 已把 `SCREENSHOT_SOURCE_WIRED`/`PUSH_CHANNEL_WIRED` 设为 true | 注释过期；实际圈选已接 MediaProjection，设置页仍因 `attachment-status-v1` 永不协商而不可用 | `[P]ConversationUiCapabilities.kt:62-92`；`[P]SettingsCapabilityUi.kt:42-51, 113-150` |
| A5 | `pairingSummary` 在 App 里按字符串读，Schema 定义是对象 | 按 Schema 返回对象时设置页显示“未提供”；两宿主实际都不返回 | `[G]auth/GatewayAuthClient.kt:253`；`session.schema.json#/$defs/pairingSummary` |
| A6 | 登录 URL 带路径时只在协商阶段失败（`NON_CANONICAL_TARGET`/404），UI 不阻止 | 用户会看到“连接失败”而不是“地址不能带路径” | `[G]http/GatewayTransport.kt:214-217`；`[G]http/CanonicalTarget.kt:70-75` |
| A7 | `WorkbenchController` 无条件加载命令目录，不检查能力位 | 网关没实现 `/commands` 时，输入 `/` 才暴露错误；启动时无提示 | `[U]state/WorkbenchController.kt:1062, 1235-1248` |
| A8 | 上传流程无条件 `GET /attachments/{id}`，不检查 `attachment-status-v1` | 网关若只实现 create/upload/commit 而漏 status，附件发送会失败；能力位不能作为“可跳过”的信号 | `[G]attachments/AttachmentUploader.kt:109-123` |

以上 A1–A4、A7–A8 都属于 App 侧可修的小问题；**在 App 未修之前，DSH 应按 App 的实际行为适配**，不要基于能力位做“跳过端点”的假设。

### 8.3 可选扩展点（DSH 可以自行决定是否实现）

| 扩展 | 价值 | 代价/风险 | 建议 |
|---|---|---|---|
| `message-batches-v1` + `newline-v1` | 连续输入合并为一次 Agent 回合，减少打断 | 需要新端点、成员 ID 映射、批次状态与恢复 | P1 |
| `generation-cancel-v1` | 停止生成 | 需要 current-generation 查询 + cancel 端点 + 终态事件 | P1（体验关键） |
| `agent-approval-cards-v1` | 结构化审批，避免文本命令 | 需要事件、决策端点、超时/撤回终态 | P1 |
| `conversation-management-v1` | 归档/删除/文件夹/排序，跨设备一致 | 需要宿主原生会话管理 API、组织状态 CAS | P1 |
| WebSocket `/events/ws` | 低开销双向通道 | App 已支持 SSE 降级，收益有限 | P2 |
| 邀请配对 | 无需密码的配对 | 需要 challenge/签名校验/一次性邀请 | P2 |
| 设备密钥登录 | 冷启动免密 | 需要设备挑战/签名校验 | P2 |
| 设备请求 + 插件能力发布 | 通知/短信/通话记录 | 需要完整 claim/result、能力发布、权限/风险确认 | P2 |
| `/sync/snapshot` | 游标过期恢复 | 需要基线事件 + 快照 | P1（长期运行必备） |
| 屏幕圈选 `visualContext` | 圈选上下文 | App 侧 `attachment-status-v1` 永不协商，设置页不可用；但浮动助理仍可把 PNG 作为附件上传 | P2（无需网关专用字段） |

### 8.4 “最小化改动 App”的结论

- **不要改**：基路径、协议版本、Schema 摘要、签名、信封、事件帧、消息/附件/审批/设备请求的字段形状。这些都是 App 已冻结的线上契约。
- **可以改（但不建议作为 DSH 的前提）**：A1–A8 这些 App 小问题。DSH 应假设 App 仍按当前行为调用端点。
- **不需要为 App 增加的端点**：`/models`、`/regenerate`、`/search`、`/shared-folders`、`/health`（App 不调用）。做了也不会被使用。
- **需要为 App 保留的“事实标准”端点**：`/commands`、`GET /attachments/{id}`、`GET /pairings/current`，即使不声明对应能力位也会被调用。

---

## 9. DSH 网关功能验收清单

### 9.1 P0：没有这些，App 无法完成基本连接/对话

| ID | 验收项 | 验收方法 | 通过标准 |
|---|---|---|---|
| P0-01 | origin-only 基路径 `/open-android-intelligence/v2`，无重定向 | 用 App 输入 `https://host:port` 登录；抓包确认请求路径 | 不出现 `NON_CANONICAL_TARGET`/404；`Location` 不出现 |
| P0-02 | `POST /negotiate` 严格响应 | 用契约向量或 curl 构造响应；App 登录 | envelope `protocol:"2.1"`；`data` 四键；`features` 五键 + 可选 conversationUi；基础能力为单值字符串；`limits` 三键；`gatewayIdentity.deploymentId` 合法；core hash 匹配 |
| P0-03 | 密码登录 | App 输入正确账号密码 | 返回 `accountId/deviceId/sessionId/accessToken/refreshCredential`；进入工作台 |
| P0-04 | 请求签名验证 | 任意已认证请求 | 九 header 各恰好一次、签名通过、时间窗/ nonce / requestId / Idempotency-Key 正确；错误码符合契约 |
| P0-05 | 会话列表 + 创建 | App 首屏/新建对话 | `GET /conversations` 返回 `{conversations,nextCursor,snapshotRevision}`；`POST /conversations` 返回 `{conversation}`；重复 `clientConversationId` 返回同一会话 |
| P0-06 | 时间线读取 | 打开会话 | `GET /messages` 返回 `{messages,nextCursor,snapshotRevision}`；`messageId`、`sender`、`parts`/`text`、`timestamp` 可读；分页不混快照 |
| P0-07 | 发送消息 | App 发“你好” | `POST /messages` 返回 `{message:{status:"accepted",messageId,conversationId,generationId?}}`；重复 requestId 幂等 |
| P0-08 | SSE 事件流 | App 发消息后观察 | `GET /events` 返回 `text/event-stream`；心跳 <20s；`delta` 累积文本、`completed`、用户 `status` 终态都到达；断线后按 `cursor` 续传；410 返回 `CURSOR_EXPIRED` |
| P0-09 | 流式正文语义 | 长回复 | 每个 `delta` 是完整 `parts`/`text` 覆盖；`revision` 递增；App 不闪烁/不丢字；最终 `completed` |
| P0-10 | 生成终态 | 一轮完成 | 用户消息 `status` 走到 `completed`（或 `failed` + 合法 errorCode）；App 生成状态结束；后续轮次不被旧事件关闭 |
| P0-11 | 附件上传闭环 | 选图/文件发送 | `POST /attachments` → `GET /attachments/{id}`（`staged`）→ `PUT content`（`Content-Type`/`Content-Length`/`Digest`）→ `POST commit`（`uploaded`）→ `POST /messages` 带 attachmentId；消息内显示附件 |
| P0-12 | `GET /commands` | App 输入 `/` | 返回合法目录；命令项可显示/填入；失败时至少不阻塞发送 |
| P0-13 | `GET /pairings/current` | App 连接后 10s 内 | 返回合法 envelope + `data.grantRevision`（整数）；不发生“设备能力授权同步失败”的重试提示循环；`grantDigest` 与 revision 的处理符合 §6.1 第 3/4 行 |
| P0-14 | 401 刷新 | 手动使 access token 失效 | App 自动 `POST /sessions/refresh` 并重试原请求；新 refresh credential 被保存；不丢用户操作 |
| P0-15 | 错误信封 | 构造 401/404/409/500 | `error.code` 是大写稳定码；`retryable` 正确；App 显示可读文案而非崩溃 |
| P0-16 | 幂等/查询 | 断网重发、重复请求 | `GET /messages?clientMessageId=` 返回原消息；重复 `Idempotency-Key` 返回原终态；不产生重复消息 |
| P0-17 | 无路径前缀/无重定向/心跳/超时 | 部署验收 | 满足 §2.2、§3.4；App 不出现 `EVENT_STREAM_STALLED` |

### 9.2 P1：保留主要设计功能

| ID | 验收项 | 验收方法 | 通过标准 |
|---|---|---|---|
| P1-01 | 停止生成 | App 点停止 | 协商 `generation-cancel-v1`；`GET /generations/current` 返回 `{generation:null|{...}}`；`POST cancel` 返回 `CANCELLED/ALREADY_COMPLETED/UNSUPPORTED/OUTCOME_UNKNOWN`；App 显示“已停止/已完成/不支持”并收到终态 |
| P1-02 | 消息批次 | 设置防抖 1.5s，连续发 3 条 | 协商 `message-batches-v1` + `newline-v1`；`POST /message-batches` 的 `members[]` 映射完整；`joinMode:"newline-v1"`；App 显示“等待合并”并只产生一轮回复 |
| P1-03 | 会话管理 | 归档/取消归档/删除/文件夹/排序 | 协商 `conversation-management-v1`；`GET/PATCH/DELETE /conversations`、`GET/PUT /conversation-organization` 返回契约形状；`CONVERSATION_BUSY` 正确；App 不本地伪造成功 |
| P1-04 | 历史媒体 | 重装 App/换设备后打开含图会话 | `metadata`/`cache-grant`/`content` 可用；`grantId` 43 位 base64url；流响应头正确；图片预览可显示、下载成功 |
| P1-05 | 审批卡片 | Agent 触发危险命令 | 协商 `agent-approval-cards-v1`；`approval.requested` 四档 `options`；决策端点成功/409 语义；`resolved` 到达；超时由 Gateway 结算；App 卡片按 Gateway 结果落定 |
| P1-06 | 命令目录能力位 | 设置页查看 | 9 键三态正确；`newline-v1` 的显示问题按 App 现状如实呈现（不是 DSH 能修的） |
| P1-07 | `/sync/snapshot` | 使游标过期（缩短事件保留/清游标） | `GET /sync/snapshot` 返回 `baselineCursor` + `pendingDeviceRequests[]`；App 安装基线并重连；不无限失败 |
| P1-08 | 会话变更事件 | 两个客户端同时开 | `conversation.title.updated`/`conversation.updated`/`organization.updated` 使列表/标题/文件夹刷新；无事件时最多表现为延迟刷新 |
| P1-09 | 重命名持久化 | 顶栏改名/自动标题 | `PATCH /conversations/{id}` `{title}` 2xx；App 刷新列表后标题保留；失败时 App 回退标题 |
| P1-10 | 解除配对 | 设置 → 解除配对 | `DELETE /pairings/current` 返回精确回执（deviceId + 六 true）；App 清本机密钥；回执不完整时保留并提示 |
| P1-11 | 退出登录 | 抽屉退出 | `DELETE /sessions/current?revokeRefresh=true` 2xx；App 清 refresh/last profile；失败保留 |
| P1-12 | 事件流恢复 | 断网/切网/后台恢复 | 游标续传、无重复事件、失败不超过 6 轮；恢复后通知/会话刷新 |

### 9.3 P2：完整保留/设备与替代认证

| ID | 验收项 | 验收方法 | 通过标准 |
|---|---|---|---|
| P2-01 | 邀请配对 | 生成 `oai://pair?…`，粘贴/深链打开 | challenge 字段精确、签名校验通过、`/pairings/exchange` 返回 SessionBundle；邀请一次性/过期/跨账号拒绝 |
| P2-02 | 设备密钥登录 | 冷启动点“使用已配对设备密钥登录” | challenge 字段精确、签名校验通过、返回 SessionBundle；设备密钥不能跨账号 |
| P2-03 | 设备请求 | Agent 发起通知/短信/通话读取 | `device.requested` + `GET /device-requests/{id}`（`data.request`）+ claim + result 全链路；回执绑定/幂等/generation/revision 正确 |
| P2-04 | 设备能力发布 | 安装/启用/授权插件 | `GET /pairings/current` + `POST /pairings/current/capabilities` 的 JCS digest 与 App 一致；`grantRevision`/`grantDigest` 正确；无 `CAPABILITY_DIGEST_MISMATCH` 循环 |
| P2-05 | 通知读取 | 通知插件 + 白名单 + 系统授权 | 设备请求可读；撤销权限/授权后拒绝；无后台静默扫盘 |
| P2-06 | 短信读取/发送 | SMS 插件 + 人工确认 | 查询可读；写/高权限请求必须前台确认；拒绝返回 `denied` |
| P2-07 | 通话记录 | call-log 插件 | 只读元数据；无录音/拨号 |
| P2-08 | WebSocket | 让 DSH 支持 `/events/ws` | 101 握手、签名、PING/PONG、文本帧 `id/event/data`；App 优先 WS，失败回 SSE |
| P2-09 | 屏幕圈选 | 浮动助理 → 圈选 → 确认 | PNG 作为附件上传；不依赖 `attachment-status-v1`；设置页条目仍按 App 现状显示“未声明” |
| P2-10 | Live Updates/气泡 | Android 16/通知气泡 | 任务状态、完成/失败/取消移除；无重复提醒；不要求网关新端点 |

---

## 10. 一页纸：DSH 网关插件 MVP 建议

### 10.1 范围（只做这些）

**目标**：让当前 App 能完成“登录 → 看到会话 → 发文字/图片 → 收到流式回复 → 重启后自动恢复”，不追求设备插件、审批和会话管理。

**必须实现**：

1. **HTTP 载体**
   - origin 根路径，固定基路径 `/open-android-intelligence/v2`；不重定向；HTTP 或 HTTPS 二选一（HTTPS 推荐配 SPKI）。
   - 严格响应信封 `{requestId,correlationId,protocol:"2.1",data}` / `{error:{code,message,retryable,details}}`。
   - 九 header 签名验证 + `Idempotency-Key` 单例；`GET /events` 的 410/401 语义。
2. **认证**
   - `POST /negotiate`（严格形状，core hash 用仓库内置 `contract/schemas` 计算）。
   - `POST /sessions/password`（Ed25519 设备公钥入库，签发 access token + refresh credential）。
   - `POST /sessions/refresh`（轮换 refresh；401 时 App 会自动调用）。
   - `DELETE /sessions/current`（允许仅 Bearer + 身份头的豁免路径）。
3. **对话**
   - `GET /conversations`（支持 `limit`/`cursor`，`nextCursor=null` 表示结束；至少返回 `conversationId/title/updatedAt/archived`；**不要只返回活跃会话**）。
   - `POST /conversations`（按 `clientConversationId` 幂等，创建独立 Agent 会话并持久化绑定）。
   - `GET /conversations/{id}/messages`（返回 `messages`、`nextCursor`、`snapshotRevision`；`timestamp` 用 epoch ms；`sender` 用 `user`/`assistant`）。
   - `POST /conversations/{id}/messages`（按 `clientMessageId` 幂等；返回 `status:"accepted"`、`messageId`、`generationId`）。
   - `GET /conversations/{id}/messages?clientMessageId=`（丢失 ACK 时查询原消息）。
4. **事件流**
   - `GET /events?cursor=`：SSE，`text/event-stream`，`id/event/data`，心跳 < 20s，断线按游标续传，410 返回 `CURSOR_EXPIRED`。
   - `conversation.message.delta`：**累积** `parts`/`text` + `messageId` + `conversationId` + 递增 `revision` + `generationId`。
   - `conversation.message.completed`：同形，终态正文。
   - `conversation.message.status`：用户消息 `queued/delivered/completed/failed` + `clientMessageId` + `revision` + `errorCode`（失败必填，其余 null）。
5. **命令目录**
   - `GET /commands?languageCode=`：返回 `format`、`catalogVersion`（建议用 wire ID；非 wire ID 会被 App 显示为 `unknown`）、`languageCode`、`commands[]`（`invocation`、`description`、`argumentHint?`）。
   - 即使不在 `conversationUi` 里声明 `agent-command-catalog-v1`，App 也会调用；**必须实现**。
6. **附件**
   - `POST /attachments`（`clientAttachmentId` 幂等）→ `GET /attachments/{id}`（`status/sizeBytes/sha256`）→ `PUT /attachments/{id}/content`（`Content-Type`/`Content-Length`/`Digest`）→ `POST /attachments/{id}/commit`。
   - `POST /messages` 接受 `attachments:[{attachmentId}]`；附件必须属于当前账号/会话。
7. **最小配对状态**
   - `GET /pairings/current`：返回合法 envelope + `grantRevision`；**建议让 revision 与登录响应的 `grantRevision` 一致，且暂不返回 `grantDigest`**，这样 App 的 `CapabilityPublisher` 会走“无摘要”早退路径，不触发 POST、也不显示错误循环。
   - 如果以后要做设备插件，再实现 `POST /pairings/current/capabilities` 与 digest 规则。

**建议实现（成本低、体验提升明显）**：

- `PATCH /conversations/{id}` `{title}`：自动标题/重命名。
- `GET /conversations/{id}/generations/current` + `POST .../cancel` + `generation-cancel-v1`：停止生成。
- `conversation.title.updated` / `conversation.updated`：列表实时刷新。
- `DELETE /sessions/current` 的 401 重试兼容。

### 10.2 明确不做（MVP 外）

- 不做 `/models`、`/regenerate`、`/search`、`/shared-folders`、`/health`（App 不调用）。
- 不做 `conversation-mirror-v1`、`attachment-status-v1` 的能力声明（App 不声明；多回会让协商失败）。
- 不做消息批次、审批卡、会话管理、邀请、设备密钥——这些都可以通过“不在 `conversationUi`/`auth` 里声明对应能力”安全降级。
- **设备请求不能“不声明”**：协商响应里的 `features.deviceRequests` 必须是 `risk-queue-v1`，否则登录直接失败。MVP 的做法是照常回 `risk-queue-v1`，但不发送 `device.requested`，也不实现 `GET/claim/result` 设备端点；App 只会装配一个空执行通路，不会报错。
- 不做 WebSocket；SSE 足够，但要对 `/events/ws` 快速返回 404/426，避免 10s 连接超时。
- 不做 `/sync/snapshot` 的初始版本；把事件保留时间设长（例如 7 天），并在文档里标注“游标过期需重新登录/重连”的已知限制；若要长期运行，第二波补上。

### 10.3 MVP 的最小状态模型

```text
Account(id, username, password_hash, created_at)
Device(device_id, account_id, installation_id, public_key, pairing_generation, grant_revision, refresh_hash)
Session(session_id, account_id, device_id, access_token_hash, expires_at, status)
Conversation(conversation_id, account_id, client_conversation_id, title, archived, updated_at, agent_session_id)
Message(message_id, conversation_id, client_message_id, sender, state, revision, generation_id, timestamp, parts_json)
Event(event_id, account_id, seq, type, payload_json, occurred_at)   -- event_id 同时是 cursor
Idempotency(key, request_id, operation, input_hash, status, response_json, expires_at)
Attachment(attachment_id, account_id, client_attachment_id, filename, media_type, size, sha256, status, storage_path, expires_at)
```

关键约束：

- `Event.event_id` 单调递增且符合 wire ID；`GET /events?cursor=` 按 seq 读取；游标持久化。
- `Message.revision` 每次内容变化递增；`delta` 覆盖写。
- `Conversation.agent_session_id` 是**宿主内部概念**，不下发客户端；同一 `conversationId` 永远绑定同一个 Agent 会话。
- `Idempotency` 覆盖 `POST /messages`、`POST /conversations`、`POST /attachments`、`PUT content`、`POST commit`、`DELETE` 等变更请求。

### 10.4 与 DSH Agent 的映射

- 一个 `Conversation` ↔ 一个 DSH Agent Session（通过 `ctx.agents` 创建/复用；参见 `docs/research/dsh-host-api.md` §2/§3）。
- 用户消息 → 向该 Agent Session 投递一个 user turn；订阅该轮的 assistant stream，把每个文本增量**累积**成完整正文，生成 `conversation.message.delta`；轮次结束发 `conversation.message.completed`，同时把该 user message 的 `status` 走到 `completed`。
- 工具调用/思考：如果 DSH 的 assistant stream 有结构化事件，可在最终文本里按 §7.4 的 XML 标记渲染；不做也不影响 P0。
- 取消：DSH 的 agent cancel API 映射到 `POST /generations/{id}/cancel`，成功后发 `conversation.generation.cancelled` 或把 user status 置终态。
- 附件：DSH 附件存储（`ctx.attachments`）接收 App 上传字节；发消息时把 attachmentId 映射到 DSH 附件，交给 Agent。

### 10.5 MVP 手工验收脚本

1. 安装当前 APK，输入 `https://<host>:<port>` + 账号密码，确认进入工作台，无 `PROTOCOL_INCOMPATIBLE`。
2. 输入 `/`，确认命令面板显示命令（至少不报“无法加载”）。
3. 新建对话，发“你好”，确认：
   - 立即出现用户气泡；
   - 助手气泡逐段增长（不是一次性出现）；
   - 生成状态最终变为完成（不是一直“正在接收回复”）。
4. 选一张图发送，确认附件卡、图片预览、消息送达。
5. 杀进程重启，确认自动恢复（refresh）并仍能看到历史/会话。
6. 断网 30s 再恢复，确认 SSE 重连、没有重复消息、没有“通道已断开”长期停留。
7. 手动刷新凭据/退出登录，确认后端轮换与本地清理。
8. 键入一个不存在的 `/foo`，确认原样发送、不崩溃。

---

## 附录 A：App 实际调用的端点总表

| 方法 | 路径（省略基路径） | 调用方 | 是否受能力位门禁 | 备注 |
|---|---|---|---|---|
| POST | `/negotiate` | `NegotiationClient` | — | 认证前；严格响应 |
| POST | `/sessions/password` | `GatewayAuthClient` | — | 认证前 |
| POST | `/sessions/invite/challenge` | 同上 | `account-invitation`（仅 UI 不门禁） | 扩展 |
| POST | `/pairings/exchange` | 同上 | 同上 | 扩展；App 用此路径，不用 `/sessions/invite/exchange` |
| POST | `/sessions/device/challenge` | 同上 | `device-key`（仅 UI 不门禁） | 扩展 |
| POST | `/sessions/device` | 同上 | 同上 | 扩展 |
| POST | `/sessions/refresh` | 同上 | `refresh` | 认证前；自动/手动 |
| DELETE | `/sessions/current?revokeRefresh=` | 同上 | — | 签名豁免 |
| DELETE | `/pairings/current` | `PairingRevocationClient` | — | 完整签名 |
| GET | `/pairings/current` | `CapabilityPublisher` | 无（始终调用） | 扩展 |
| POST | `/pairings/current/capabilities` | 同上 | 无（按摘要决定） | 扩展 |
| GET | `/sync/snapshot` | `GatewayRuntime`/`PlatformSnapshotRecovery`/`BubbleConversationWorkspace` | 无（仅游标过期） | 扩展 |
| GET | `/commands?languageCode=` | `CommandCatalogClient` | 无（始终调用） | 能力位只影响展示 |
| GET | `/events?cursor=` | `GatewayHttpClient` | — | SSE |
| GET | `/events/ws?cursor=` | `GatewayWebSocketTransport` | — | 可选；失败回 SSE |
| GET | `/conversations?cursor=&limit=` | `ConversationClient` | 无（始终调用） | 支持 `nextCursor`/`snapshotRevision` |
| POST | `/conversations` | 同上 | 无 | `clientConversationId` 幂等 |
| GET | `/conversations/{id}` | 同上 | 无 | 仅在 `/new` 创建宽限/元数据用 |
| PATCH | `/conversations/{id}` `{title}` | 同上 | 无（顶栏可用） | 抽屉菜单受 management 限制 |
| PATCH | `/conversations/{id}` `{archived}` | 同上 | `conversation-management-v1` | |
| DELETE | `/conversations/{id}` | 同上 | 同上 | |
| GET | `/conversations/{id}/messages?cursor=&limit=&clientMessageId=` | 同上 | 无 | |
| POST | `/conversations/{id}/messages` | 同上 | 无 | |
| POST | `/conversations/{id}/message-batches` | 同上 | `message-batches-v1`+`newline-v1` | |
| GET | `/conversations/{id}/generations/current` | 同上 | `generation-cancel-v1` | |
| POST | `/conversations/{id}/generations/{gid}/cancel` | 同上 | `generation-cancel-v1` | |
| GET | `/conversation-organization` | 同上 | `conversation-management-v1` | |
| PUT | `/conversation-organization` | 同上 | 同上 | |
| GET | `/conversations/{id}/attachments/{aid}/metadata?format=stream-v1` | `EncryptedHistoryMediaCache` | 无 | 历史媒体 |
| POST | `/conversations/{id}/attachments/{aid}/cache-grant?format=stream-v1` | 同上 | 无 | |
| GET | `/conversations/{id}/attachments/{aid}/content?format=stream-v1&grantId=` | 同上 | 无 | 流式 |
| POST | `/attachments` | `HttpAttachmentTransport` | 无 | 三步上传 |
| GET | `/attachments/{id}` | 同上 | 无（始终调用） | 状态查询 |
| PUT | `/attachments/{id}/content` | 同上 | 无 | 原始字节 + Digest |
| POST | `/attachments/{id}/commit` | 同上 | 无 | |
| POST | `/approvals/{id}/decisions` | `ApprovalClient` | `agent-approval-cards-v1` | |
| GET | `/device-requests/{id}` | `DeviceExecutionDriver` | `deviceRequests` | 扩展 |
| POST | `/device-requests/{id}/claim` | `HttpDeviceRequestTransport` | 同上 | |
| POST | `/device-requests/{id}/result` | 同上 | 同上 | |

## 附录 B：参考宿主证据索引

| 用途 | 文件:行 |
|---|---|
| App 声明 7 个 conversationUi 能力 | `apps/android/gateway-client/src/main/kotlin/com/openandroidintelligence/gateway/negotiation/NegotiationClient.kt:21-29` |
| App 设置页 9 键闭集 | `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/ConversationUiCapabilities.kt:10-23` |
| App 客户端 offer 6 键（漂移） | `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/GatewayRuntime.kt:95-102` |
| 协商响应强校验 | `.../NegotiationClient.kt:156-203` |
| 登录/刷新响应解析 | `.../auth/GatewayAuthClient.kt:236-259` |
| 邀请/设备挑战 | `.../auth/GatewayAuthClient.kt:91-120` |
| 身份 trust / 降级拒绝 | `.../GatewayIdentityTrustStore.kt:26-90` |
| 事件流 SSE + WS + 退避 | `.../http/GatewayHttpClient.kt:289-478` |
| SSE 帧解析 | `.../events/SseParser.kt:124-166` |
| 时间线解析 | `.../conversations/ConversationClient.kt:338-385, 602-629` |
| 分页完整性 | `apps/android/conversation-domain/src/main/kotlin/com/openandroidintelligence/conversation/ports/ConversationPorts.kt:442-512` |
| 流式事件解码 | `apps/android/conversation-data/src/main/kotlin/com/openandroidintelligence/conversation/data/GatewayEventDecoder.kt:88-308` |
| 审批事件 | 同上 `:210-260` |
| 工作台发送/停止/门禁 | `.../conversation/state/WorkbenchController.kt:2219-2480, 2870-2913, 3273-3345` |
| 会话管理 UI | `.../workbench/ConversationBrowser.kt:127, 245-279, 453-461` |
| 附件上传 | `.../attachments/AttachmentUploader.kt:90-145`；`HttpAttachmentTransport.kt:48-125` |
| 历史媒体 | `.../mobile/conversations/EncryptedHistoryMediaCache.kt:109-133, 180-205` |
| 设备请求执行 | `.../mobile/plugins/DeviceExecutionDriver.kt:32-160` |
| 能力发布 | `.../mobile/plugins/CapabilityPublisher.kt:23-65` |
| 解绑回执 | `.../auth/PairingRevocationClient.kt:10-30` |
| 参考宿主路由 | `hermes.../http.py:496-519`；`openclaw.../src/http/routes.ts:796-823` |
| 参考宿主 `/sync/snapshot` | `hermes.../core.py:5495-5499`；`openclaw.../src/core/gateway-core.ts:1041-1046` |
| 参考宿主 `/pairings/current` | `hermes.../core.py:5504-5509` |
| 参考宿主设备详情 | `hermes.../core.py:5535-5537` |
| 参考宿主设备 claim/result | `hermes.../core.py:5674-5694` |

---

## 附录 C：术语表（面向非 Android 读者）

| 术语 | 通俗解释 |
|---|---|
| Gateway / 网关 | 手机连接 Agent 的入口；本项目中由宿主插件提供 HTTP + SSE |
| 协商（negotiate） | 登录前双方确认协议版本、能力位和 Schema 版本 |
| 能力位（capability） | 一张“我支持这个功能”的声明；App 按交集决定 UI |
| 降级（degradation） | 网关不支持时，App 明确显示不可用，而不是假装成功 |
| 幂等（idempotency） | 同一请求重试多次，结果与一次相同；靠 requestId / clientMessageId 绑定 |
| 游标（cursor） | 事件流/分页的位置标记；断线后从这里继续 |
| SPKI pin | 证书公钥的 SHA-256 指纹；用来固定 Gateway 身份，防中间人 |
| 审批卡（approval card） | Agent 要执行危险命令时，发给用户点“允许/拒绝”的结构化卡片 |
| 设备请求（device request） | Agent 要读通知/短信等手机能力时，向手机发起的受控请求 |
| 会话（conversation） | 手机界面里的一条对话线程；对应宿主的一个 Agent 会话 |
| 生成（generation） | 一次 Agent 回复过程；可停止、可查询当前状态 |
