# DSH Android Gateway 全面代码审计与 OAI Core 兼容性验证

审计日期：2026-11-11（北京时间）。本轮只审查、执行隔离测试和生成报告；没有修改生产代码、提交 Commit、建立 Issue/PR、操作既有 DSH 会话或 Android 设备。所有新增消息、账号、数据库和桥密钥均为隔离测试数据。

## A. 总体结论

**独立插件能够连接当前 OAI Core，但尚未达到可靠发布标准。** 本轮以真实 DSH `0.2.2-rc.1` 加载独立插件，实际执行了当前 Core 的 HMAC 握手、身份库注册回读、健康检查、会话发现、创建、空历史读取、重命名及宿主重启后持久会话回读。以上限定链路通过；历史上的“缺少 handshake 路由”已经修复，不是本轮缺陷。

**连接稳定性、消息完整性与异常恢复不能判定为正常。** 已复现受理回执悬挂后永久 Busy、取消忽略目标生成轮次、消息身份信息丢失、慢消费者写缓冲缺乏上限，以及长会话拖垮整个会话列表。Core 的安装后重启还可能选错 Profile；内置对照版本则存在与本机实际 DSH `prompt` 签名不一致的反向漂移。因此既不能以独立版本与内置版本不同就定错，也不能建议直接覆盖为内置版本。

| 要回答的问题 | 本轮结论与证据边界 |
|---|---|
| 当前版本能否正常连接 Core？ | **能完成所测连接与注册链路。** 真实宿主 + 真实 Core 库函数验证通过；未运行完整 Core HTTP 登录服务及 Android 登录界面。 |
| 连接是否稳定？ | **不能确认稳定。** 一次真实重启恢复通过，仍有受理悬挂/资源释放缺陷；Token 无缝轮换、热重载及长时间运行未验证。 |
| 会话功能是否可靠？ | 基础创建、发现、重命名和重启保留通过；一个超长会话可使全列表失败。终端 UI 与 App 的完整双向体验未实测。 |
| 消息功能是否可靠？ | **不足。** 正常增量和终态在隔离契约测试通过，但身份、取消、未知结果和背压存在问题。真实宿主的无模型凭据失败路径可返回 `AGENT_FAILED`；这不是模型回复成功。 |
| 是否存在阻碍正常使用的 Bug？ | **存在。** AUD-001、002 可影响任务和后续发送；AUD-006 可中断其他宿主；AUD-007 使对照内置版本在所测宿主上无法正常受理发送。 |
| 是否有关键功能缺失？ | 两版均缺少可靠生成恢复、附件桥接、宿主审批/工具事件和原生命令通路。是否列为发布必需取决于承诺的产品范围，不能标成已支持。设备授权和设备调用仍归 Core/Android。 |
| 是否达到可发布标准？ | **本轮不建议发布。** 先解决 P1 与当前客户端必需的身份/恢复问题，再补隔离真实模型和 Android 全链验证。未发现有证据支持的 P0；这不代表已证明不存在其他安全问题。 |

### 审计快照与“最新代码”的处理

| 对象 | 版本/分支 | 审查提交 |
|---|---|---|
| `1rua/dsh-android-gateway` | 默认分支 `main`，package `0.3.0` | `325a48058dafbfdb0686dc060e08674d8810b4c1` |
| 独立仓库 `dev` | 同时核对分支状态 | `59aad2b0559a950c7b687914eb9089ddf9c8269c`；落后于默认分支的握手修复，不能拿它替代默认分支审计 |
| `1rua/open-android-intelligence` | 用户指定 `dev`，Core `0.2.0` | **最终审查** `24172841f9a564c53416f7d066f3450d4feb2bfe` |
| OAI 执行测试时快照 | `dev` 在审计开始时的提交 | `d5b82cb6f796a08838f3a1136b8fbb77e22c0f49` |
| 实际 DSH 宿主 | 本机已安装发行包 | `@deepseek-ai/dsh 0.2.2-rc.1`，未宣称它是 DSH 上游最新版本 |
| 测试运行时 | Linux，Node `v26.7.0`，Python `3.14.6` | pytest `9.1.1`，aiohttp `3.14.5`；独立 Vitest `3.2.4`、OAI 已安装 Vitest `4.1.10` |

收尾时远端 `dev` 前进了一次，新增提交为 Android 文案资源迁移。已另建只读检出核对：两提交的 `oai-core/` tree 均为 `cbd39c00de0a696136d8f73f6c9e5a25e404a310`；内置 DSH Adapter tree 均为 `155457d23f5761c5b025c434de365eed70f1b688`；`AgentSessionClient.kt` blob 均为 `3f06b50a1c1f535c2c65fa75152e0ef56edba498`。另外逐行核对了 12 处 Android 发送、身份、恢复、取消和去重片段，相关行为未变。本报告的 Android 行号按最终提交修正。**没有把旧提交上执行的测试伪称为在新检出上重新执行。** 详见 [快照增量复核](evidence/2026-11-11-dsh-core/latest-delta.md)。

后文 `DSH/` 表示独立仓库根目录，`OAI/` 表示 OAI 仓库根目录；宿主路径以已安装 DSH 的 `node_modules/@deepseek-ai/` 为基准。源码位置均属于以上固定快照。

Android文件名在后文使用以下唯一对应路径，避免省略包路径导致定位含糊：

| 文件名 | OAI根目录下的完整相对路径 |
|---|---|
| AgentSessionClient.kt | `apps/android/gateway-client/src/main/kotlin/com/openandroidintelligence/gateway/agents/AgentSessionClient.kt` |
| CoreAgentConversationRepository.kt | `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/conversations/CoreAgentConversationRepository.kt` |
| GatewayRuntime.kt | `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/GatewayRuntime.kt` |
| WorkbenchController.kt | `apps/android/conversation-ui/src/main/kotlin/com/openandroidintelligence/conversation/state/WorkbenchController.kt` |

宿主实际发行文件额外固定SHA-256：`dsh-api-session-controller/lib/index.js` 为 `4cf6c66e65cce865d270fa89405b96d048ffa62e493e4ffbd1a826be2207a4cd`；`lib/types/commands.js` 为 `22a873ee9b1d4ea78ae6327f265ff9d7e0383250ad017b1eb580765fdf6cbb1c`。它们是安装包文件指纹，不是上游Git提交。

### 关键调用链及协议核对

```text
Android AgentSessionClient / CoreAgentConversationRepository
  → OAI sessions.py（客户端认证、能力门禁、操作回执、SSE观察）
  → DshSessionAdapter → RemoteSessionAdapter（桥Bearer、HTTP/NDJSON）
  → DSH createSessionHandler（HMAC握手、原生会话投影、prompt观察）
  → 真实 sessionQuery / SessionController / SessionCommandController
  → DSH 原生会话持久层、inbox 和 Agent turn

Android设备能力：Core CLI/MCP/API → Core设备授权/调度 → Android
```

| 契约 | 当前实现核对 | 结论 |
|---|---|---|
| Bundle 加载与注入 | 独立 `cordis.patch.yml` 插入 `oai-session-adapter`；`src/index.js:5-6,254-265` 注入 query、按需读取 controller，loopback 启动 HTTP | 独立真实加载通过；安装升级另有边界 |
| 发现与注册 | Core `configuration.py:1288-1324` 生成候选；`agent_registration.py:536-604` 实际调用 handshake 并验证身份/密钥 | 真实注册与读取通过；多 Profile 自动配置不足 |
| Bearer/HMAC | 独立 `src/index.js:65-69,171-188`；Core `agent_registration.py:167-193,274-300` | 挑战、实例、scope、online 和能力共同签名；无认证拒绝已测 |
| instanceId/sessionScope | 配置默认 `dsh`，可自定义；scope 固定 deployment，Core 校验一致性 | 符合共享部署会话架构；不是账号私有隔离 |
| 请求 Schema | 仅 text 的消息体、title 的创建体、value 的管理体；1MiB 边界；无 query、未知字段拒绝 | 基础兼容；新增身份字段须协商，不能直接强推给旧桥 |
| 健康与在线 | `GET /status` 实际调用 listSessions；online 依赖 list/history；Core 周期健康由 `agent_health.py` 管理 | 已测真实健康；不等于模型和所有写能力就绪 |
| NDJSON | 独立输出 delta/done/error；Core `remote.py:448-549` 有界逐行解析、终态检查、错误归因 | 基本格式兼容；独立缺身份、背压和可靠恢复 |
| 版本不一致 | 无独立 semver 握手门禁，按端点、HMAC 与能力降级；Core 能区分缺握手/认证失败/不可达 | 基础可降级，函数存在不能证明宿主方法签名兼容，见 AUD-007 |
| 宿主重启/热重载 | apply 的 dispose 关闭连接；重启重新读环境；Core 重新健康探测 | 独立重启回读通过；进行中生成恢复、热重载、轮换未验证 |

## B. 问题清单

分类约定：**已确认缺陷**表示调用链/契约确定有误；**已复现 Bug**另有本轮可重复证据；**潜在风险**说明后果尚未在完整环境实测；**功能缺失**说明没有通路或明确不支持。测试通过复现断言不表示产品正常。

### AUD-001 · P1 · 取消不匹配目标生成轮次，且回执不符合当前客户端

- **分类/归属**：已确认并复现；独立插件，实际宿主取消原语不能提供所声明的安全语义。
- **位置**：`DSH/src/index.js:81,233-246`；`OAI/oai-core/src/oai_core/sessions.py:1204-1211,1234-1242`；`adapters/remote.py:550-565`；Android `gateway-client/.../agents/AgentSessionClient.kt:161-172`。
- **触发/复现**：轮次 A 结束后同会话开始 B，延迟发送 `{value:{generationId:"old-generation"}}` 到 `/sessions/:id/cancel`。隔离处理器收到 200，宿主仅收到 `{sessionId}`。再直接调用真实宿主 `SessionCommandController.cancel`，携带旧轮次仍调用当前 Agent 的 cancel。
- **实际与预期**：实际忽略 generationId；返回 `{id,action}`，缺少客户端要求的相同 generationId 与 `cancelled/already_completed` outcome。预期仅原子取消指定轮次，过期请求不得影响新任务，并能证明取消对象。
- **根因/影响**：仅检测宿主存在 cancel 方法就声明能力；宿主方法只按会话取消当前 Agent。可误停终端或 App 的新任务。Android 正常停止路径还缺宿主 generation ID，不能因 cancel:true 声称按钮完整可用。
- **修复建议**：先关闭 cancel 声明。只有宿主支持原子比较轮次后才重开；单独“先查再取消”仍有竞态，不能根治。内置 `index.js:133-136` 已作安全降级。
- **验证要求**：A/B 竞争、过期/重复/空目标取消；非目标任务零副作用，回执与目标严格一致。
- **证据**：[消息复现及真实宿主方法测试](evidence/2026-11-11-dsh-core/message/repro.mjs)，测试“过期generationId…”及“真实安装DSH取消原语…”。没有在真实用户任务上执行取消。

### AUD-002 · P1 · 受理回执挂起后，断连、超时或已完成均不能释放 Busy

- **分类/归属**：已确认并复现；独立插件。
- **位置/函数**：`DSH/src/index.js:107-165` 的 stream，重点 `148-156`；内置对照 `index.js:270-318`。
- **触发/复现**：让 `controller.prompt()` 回执 Promise 一直不返回；分别断开观察连接、触发观察期限、提前发出原生 turn/end。测试把唯一的 30 分钟定时器压到 15ms；未改生产代码。
- **实际**：断连后仍有 2 个宿主监听器，处理器不退出；下一次同会话发送 `409 SESSION_BUSY`。超时时虽写出 `AGENT_TIMEOUT`，响应和 Busy 仍保留；done 先于受理回执时也不结束。
- **预期**：观察生命周期独立结束并释放本地资源；受理事实未确定时明确结果未知，晚到回执被安全消费。
- **根因/影响**：先 await prompt，随后才 await finishedPromise；close/计时器只能解析后者，finally 永远无法运行。可使一个会话永久不可再发，并保留响应和监听闭包。
- **修复建议**：分离受理与观察期限，使用可解除的回调槽，所有结束分支统一清理；异常/超时不能证明未执行，不应鼓励重发。内置可靠性实现可作参考，但必须同时修正 AUD-007 的真实宿主调用参数。
- **验证要求**：断连/超时/终态先到后，监听器归零、Busy 释放；晚受理、晚拒绝不得影响新观察。
- **证据**：消息复现中的三项挂起测试。已受理任务被“断观察就取消”**没有被证实**；本机真实 prompt 仅在入口检查 signal，见后文反例。

### AUD-003 · P2 · 客户端提交与原生消息身份链断裂，影响历史合并和未知结果处理

- **分类/归属**：桥字段丢失已确认并复现；Android 重复/占位残留后果为源码推导，未作真机复现。主要是独立插件；历史 rpcId 缺失两版共有。
- **位置**：`DSH/src/index.js:16-19,112,132-137,219-230`；Core `remote.py:232-235,373-374`；Android `CoreAgentConversationRepository.kt:1334-1337,1420-1446,1937-1946`、`GatewayRuntime.kt:2915`；`conversation-ui/.../state/WorkbenchController.kt:5705-5708,5754-5760`。
- **触发/复现**：对同一正文提交两次，独立插件生成两个不同 requestId；显式携带 clientMessageId 被 400 拒绝；即使合成原生事件有真实 user/assistant ID，done 仍只有 text；历史丢弃 `source.rpcId`。
- **实际与预期**：App 先用 client ID/stream 占位 ID，随后权威历史是另一组原生 ID，无法用来源关联；当前客户端明确禁止用正文/时间猜测合并。预期提交、原生 rpcId、用户消息与回复 ID 保持可核验关联。
- **根因/影响**：随机桥 requestId、不声明/支持 clientMessageIdentity、不回传原生消息 ID。Core **正常协商会省略 clientMessageId，故不能写成“所有当前 Core 发送都会 400”**。Core 操作回执可挡住同 operation 的重复，但不能补齐丢失的宿主身份；Core 状态丢失或改用新 operation 后的重试仍有重复执行风险。
- **宿主事实**：本机 DSH `SessionCommandController.prompt` 已按 inbox/历史 rpcId 去重；真实方法测试验证同 rpcId 提前 accepted。独立随机 ID 无法利用它，但不能仅凭这一测试承诺跨重启 exactly-once。
- **修复建议**：协商并透传稳定 clientMessageId，记录真实原生 userMessageId/messageId，历史保留来源关联；严禁按文字猜测或伪造 ID。内置修复了在线终态关联，历史仍需补齐。
- **验证要求**：同 ID 重试一次入队；同正文不同 ID 保持两条；实时转历史不重复；重启/未知结果按原 ID 查既有消息而不重发。
- **证据**：消息复现前三项及真实宿主去重方法测试；[客户端调用链](evidence/2026-11-11-dsh-core/core-client-findings.md)。

### AUD-004 · P2 · 慢消费者没有背压处理与观察缓冲上限

- **分类/归属**：无界写入路径已确认并复现；独立插件。进程 OOM 是潜在后果，本轮未耗尽真实内存。
- **位置**：`DSH/src/index.js:118-120,140-145`；内置对照 `index.js:13-15,174-200,256-266,303-305`。
- **触发/复现**：让响应第一次 write 即返回 false，再产生 2000 个 1KiB delta。插件仍调用全部 write，没有等待 drain 或切断观察；合成待写量约 2MiB。
- **实际与预期**：实际忽略 Node 写缓冲已满信号；预期限制观察队列的帧数/字节，等待可写，超过期限只停止观察。
- **根因/影响**：在同步宿主事件回调直接 res.write。Core 变慢、链路拥塞和多个慢观察者可持续增加 DSH 进程内存；Core 自己的帧限制不能替代插件出站缓冲控制。
- **修复建议**：有界队列、drain 与期限、统一清理；保留宿主任务独立运行。内置已有 128 帧/1MiB 等控制，可复用经验证的逻辑。
- **验证要求**：突发、永久/恢复 drain、多会话一慢一快、终态和断连，测资源上限与清理。
- **证据**：消息复现“慢消费者…”；双会话事件隔离测试通过，但没有把它等同真实网络压力或长时间内存稳定性。

### AUD-005 · P2 · 一个长会话可使整个会话列表 503，两版共有

- **分类/归属**：已确认并复现；独立插件与内置版本共有。
- **位置/函数**：独立 `src/index.js:95-100,198` 的 summary；内置 `index.js:150-155,363`。
- **触发/复现**：query 合法返回 150000 个合成事件，调用 GET /sessions。
- **实际与预期**：实际 `Math.max(...events.map(...))` 超过 JS 函数参数数量限制，抛 RangeError；整列表变成 `503 AGENT_UNAVAILABLE`。预期正常计算时间并保留所有其他会话。
- **根因/影响**：把每个事件展开成函数参数，外层又把实现错误泛化为宿主不可用。一个长期会话阻断整个部署会话发现；每次列表全量读全部历史也放大开销。
- **修复建议**：迭代求最大值，优先使用可靠的宿主摘要投影；按会话隔离错误且不得悄悄隐藏异常。
- **验证要求**：15 万及更多事件、多个正常/超长会话并存、耗时与峰值内存；不能用直接同步内置解决此项。
- **证据**：消息复现“长会话列表摘要…”。本轮未制造超长真实持久会话。

### AUD-006 · P1 · 安装后重启没有绑定所选 DSH Home / Profile

- **分类/归属**：已确认并隔离复现；**OAI Core 安装管理**，不是独立插件的会话桥职责。
- **位置/函数**：`OAI/oai-core/src/oai_core/configuration.py:1484,1499-1505,1526-1535,1613-1615,1670-1684,1704-1706,2036-2040` 的 restart_dsh_service_if_active；`scripts_runtime.py:842-843`。
- **触发/复现**：发现两个 Home，显式传入 target-home/worker，Mock systemd 表示 dsh.service active，调用真实重启函数。**没有执行真实 systemctl、SIGTERM 或停止宿主任务。**
- **实际与预期**：实际请求 `systemctl --user restart dsh.service`，完全未包含或核验所选 Home/Profile。预期仅重启经确认属于所选目标的服务，无法映射则明确不自动重启。
- **根因/影响**：固定服务名取首个 active；fallback 以 dsh+web 模糊匹配其他进程；部分调用方还丢弃已选 Profile。可中断其他实例的任务，而目标继续使用旧 Bundle。误注册非目标实例是配置组合下的潜在风险，未在真实多进程环境验证。
- **修复建议**：升级结果携带 home/profile/endpoint/服务身份至重启、注册全链；核验 WorkingDirectory、环境和启动命令，保留自定义参数；禁止模糊扫描后停止无关进程。
- **验证要求**：两个独立 Home/Profile，只升级其中一个；另一个 PID/turn 不变；所选目标恢复原启动参数，并以正确 instanceId/端口验握手。
- **证据**：[最小复现](evidence/2026-11-11-dsh-core/install/probe_restart_profile.py) 与同目录日志；[安装安全分项](evidence/2026-11-11-dsh-core/install-findings.md)。

### AUD-007 · P1 · 内置对照版本省略真实宿主 prompt 必需的 AbortSignal

- **分类/归属**：真实方法签名冲突和真实宿主失败路径均已复现；**OAI 内置 DSH Adapter**。独立版本传入 signal，不存在这一缺陷。
- **位置**：`OAI/integrations/dsh-session-adapter/index.js:287-289`；实际宿主 `dsh-api-session-controller/lib/index.js:4048-4060` 的 `SessionController.prompt(request, signal)`。
- **触发/复现**：用相同隔离 DSH 版本、配置和 Core DshSessionAdapter，分别加载独立与内置源码。内置发送只返回 `error/OUTCOME_UNKNOWN`，新建会话历史仍 0；独立发送进入宿主原生处理，因没有测试模型凭据返回 `AGENT_FAILED`，历史已有合成事件。再直接调用真实 SessionController.prototype.prompt，省略 signal 时入口 `signal.throwIfAborted()` 抛 TypeError。
- **实际与预期**：实际内置还未入队就异常，错误被 observeAdmission 的拒绝分支泛化为未知结果。预期提供不隶属观察 socket 的有效宿主 signal，同时保留受理和观察分离。
- **根因/影响**：为了不让观察连接拥有宿主任务取消权，直接删除参数，却未验证实际宿主 API 签名；Mock prompt 不要求 signal，使 89 项内置测试未发现此问题。Core 的正常状态与 send:true 不能说明真实发送可用。
- **修复建议**：按已验证宿主签名提供独立生命周期信号，或使用官方更明确的受理 API；保留观察者独立性。增加真实宿主契约测试，必要时明确支持的宿主版本范围。
- **验证要求**：真实 Cordis 注入路径可入队、真实模型回复；观察连接断开不取消已受理任务；受理悬挂仍按期限清理。
- **证据**：[内置真实宿主结果](evidence/2026-11-11-dsh-core/protocol/real-host-builtin-results.json)、[独立真实宿主结果](evidence/2026-11-11-dsh-core/protocol/real-host-standalone-results.json) 和消息复现的真实方法签名测试。上述没有模型凭据，**未宣称完成生成成功 E2E**。

### AUD-008 · P2 · 活动生成查询缺失，断线/Busy 后客户端队列恢复没有完整通路

- **分类/归属**：路由缺失已确认并复现；**两版桥接恢复能力缺失，以及 Core/Android 能力门禁衔接问题**。不是独立特有回归。
- **位置**：两版仅有现行 sessions/history/messages 等路由；Core `remote.py:292-301`、`sessions.py:874-879`；Android `CoreAgentConversationRepository.kt:1724-1739` 的 retryPendingDeliveriesFor。
- **触发/复现**：online=true、send=true 时经真实 DshSessionAdapter 调 current_generation；独立 HTTP handler 返回 `404 NOT_FOUND`。Android 在有待发队列、无本地轮次的恢复路径无条件查此接口，失败则建立 queueUnknownBarriers 并返回。
- **实际与预期**：普通同连接完成后可正常 drain，不应说所有 Queue 都坏；但重连/Busy 后恢复无法知道宿主是否仍在执行。预期只基于权威活动/终态证据安全恢复，能力不足要明确呈现未知状态。
- **根因/影响**：send 能力被用作 current-generation 路由的前置条件，桥却没有该路由和持久生成事实。队列可能长期保留，无法确认前一发送结果，人工重发有重复风险。Android UI 后果尚未真机验证。
- **修复建议**：明确只读活动生成查询与 generationRecovery 的分别能力；宿主有权威 turn 数据时桥接，Core/客户端同步门禁和降级交互；不能以空 generation、吞404或无条件重发冒充恢复。
- **验证要求**：排队后断线/Core重启/宿主重启；运行中不误投递，完成后同一消息各投一次；未知结果可用原身份查询。
- **证据**：[Core与真实插件处理器探针](evidence/2026-11-11-dsh-core/core/generation-route-probe.py)（query 为合成宿主），输出 online/send=true 与 NOT_FOUND/404；客户端后果来自当前源码。

## C. 功能覆盖矩阵与实现漂移

状态限定：**通过**均写明本轮验证层级；**有 Bug**对应上述编号；**未验证**表示虽存在实现但缺所需运行证据；**不支持**表示能力关闭或没有通路；**Core负责**不计作插件缺陷。

| 功能 | 独立 DSH 插件 | OAI 内置版本 | Core 接口/责任 | Android 实际通路与本轮状态 |
|---|---|---|---|---|
| 加载、注册、握手、健康 | 真实宿主与 Core 库集成通过 | 相同基础集成通过 | 身份库注册、HMAC、健康 | 支持描述符；完整 App 登录未验证 |
| 会话列表 | 实时 query；超长列表有 Bug 005 | 同病 | GET sessions | 能拉取；真实发现/创建回读通过 |
| 终端已有/新建会话发现 | 每次重新 listSessions | 同 | 不替代宿主 corpus | 合成新增发现测试通过；真实终端 UI 操作未验证 |
| App 创建会话 | controller.create | 同 | POST sessions、操作回执 | 真实 Core 库创建及宿主持久回读通过；App界面未验证 |
| 历史文字/顺序/原生 ID | 保留事件顺序及 message.id；身份缺陷003 | 同，历史仍缺 rpcId | GET history | 权威ID合并；合成历史通过，真实合成失败历史可读 |
| 重命名 | 已实现，真实回读通过 | 相同基础验证通过 | PATCH rename | 按能力显示；App操作未验证 |
| 归档/取消归档 | 明确不支持，cap=false | 同 | 有路由但能力门禁 | 不能把死分支算实现；不支持 |
| 删除原生会话 | 明确不支持，cap=false | 同 | DELETE 路由能力门禁 | 不支持 |
| 文字消息 | 已实现但有Bug002/003 | 在本机宿主有Bug007 | POST messages、SSE与操作ledger | 实际模型成功未验证 |
| 图片/文件发送 | 不支持；只接受text、无上传桥 | 同 | 有附件属主校验与上传能力门禁 | DSH能力关闭；不是Core本身不支持附件 |
| 原生图片/文件历史回读 | 不支持；textOf丢非文字部分 | 同 | 可代理桥附件metadata/content | App不能完整呈现DSH非文字历史；桥功能缺失 |
| 文字流增量 | 隔离契约通过；有Bug004 | 隔离测试有界队列/心跳通过；实际send有007 | NDJSON→SSE、8MiB帧限制 | 解码支持；真实模型流未验证 |
| 完成/失败终态 | 合成done/error通过；真实无凭据失败返回AGENT_FAILED | 合成终态通过；本机实际受理前OUTCOME_UNKNOWN | 终态、操作状态和错误来源 | 可解析，独立终态缺原生消息身份 |
| 精确停止/取消 | 错误声明，有Bug001 | 明确关闭以防误取消 | 目标generationId与回执契约 | 当前无法完整安全停止DSH任务 |
| 观察连接断开 | 正常受理后可清理；悬挂有Bug002 | 隔离观察实现，但需修007 | Core生产者与App观察者分离 | Core保护不能代替桥端验证 |
| 流重连/生成恢复 | 不支持持久generation查询 | 明确generationRecovery=false | 路由可代理；能力衔接有008 | 重连队列路径缺完整通路 |
| 消息身份/未知结果重试 | 有Bug003 | 在线终态身份较完整；历史仍有缺口 | operationRecovery≠宿主generationRecovery | 不能盲重发；实时/历史关联不足 |
| 多次发送/队列 | 同会话观察busy，原生mode=queue | 同，清理更完善但有007 | Core生产者/回执；宿主inbox | 普通完成可drain，断线恢复有008 |
| 多会话并发隔离 | 本轮双会话合成并发通过 | 既有相关测试通过 | Agent/session组合路由 | 没有真实多账号多Profile压力验证 |
| `/new` | 没有原生命令通路 | 同 | 创建会话API存在 | App新建走create；不支持终端命令形式 |
| 模型切换、DSH命令 | 不支持commands，无catalog/执行路由 | 同 | 有命令API与门禁 | `/model`按普通文字发送不能算切换成功 |
| 工具调用/结果显示 | 不映射结构化工具事件 | 同 | Core/Android有executionSteps数据通路 | 宿主执行工具≠App可视化；桥功能缺失 |
| 宿主审批请求/决策 | 不支持approvals，无事件/决策路由 | 同 | 有审批卡片及决策API | 需要终端介入；不能由桥伪造审批 |
| 双向列表/历史刷新 | 主动拉取已实现 | 同 | GET会话/历史 | 真实创建和重启回读通过；App/终端双界面未验证 |
| 持续事件同步/ACK | 不支持eventSync | 同 | 有events/ack协议 | 不能声称后台持续同步已支持 |
| Android设备CLI/MCP/API | **应由Core负责** | 同 | device_service/cli/mcp认证、授权、路由 | Android执行和本地授权；本轮未调用真实设备 |
| 安装/旧Bundle升级 | Bundle可加载；Core安装路径隔离测试通过 | 安装器去重旧新Bundle | Core安装管理/宿主包管理 | 真实包安装/升级未执行，不能标整体通过 |
| 更新、配置、Token管理 | 捕获进程桥Token；需正确重载环境 | 增加reloadToken尝试 | 生成私有密钥/配置同步/显式迁移 | 无缝轮换、原地更新后恢复未验证 |
| 卸载、诊断 | 使用官方Bundle管理；缺内置追踪实现 | 有diagnostics，安装错误分类较完整 | Core管理/官方plugin工具 | 真实卸载未执行，不要求桥另建卸载系统 |
| 多Profile同时自动接入 | Config支持自定义端口/实例/环境名 | 同 | 当前自动发现只产固定dsh/8791候选 | 自动多实例配置不足；重启目标另有006，手动多实例未验证 |

### 差异逐项归因

| 差异 | 类别及行为后果 |
|---|---|
| 独立main新增handshake | **已完成修复**；真实Core验证通过，不能继续报告历史404 |
| 内置clientMessageIdentity与终态原生ID | **兼容性修复/能力增强**；独立缺失导致003，不等于宿主幂等已完成 |
| 内置受理/观察期限与解除回调 | **可靠性修复**；独立存在002 |
| 内置有界队列、drain、心跳 | **可靠性增强/修复**；独立存在004。缺心跳本身不直接等于当前Core一定60秒断开，Core仅在协商streamHeartbeat后启用该空闲预算 |
| 内置cancel=false | **安全修复**；独立保留危险声明，见001 |
| 内置generationRecovery/idempotentSend=false | **诚实能力降级**；不能把关闭声明误认成功能回退Bug；底层恢复通路仍缺008 |
| 内置不再传prompt signal | **反向API漂移/回归**；本机真实宿主不能受理，见007 |
| 内置diagnostics/trace | **可观测性新增**；独立缺少细分trace，不能因此单独认定业务执行失败 |
| 内置Token重新加载尝试 | **架构/运维增强**；独立需重载。内置优先读进程环境，不能仅凭存在reloadToken宣称文件轮换无缝生效 |
| Bundle名不同、插件ID相同 | **拆仓/安装结构变化**；正常Core升级收敛activeBundles为一个新Bundle，并保留旧依赖。没有证实正常升级会重复加载 |
| 两版同样缺归档/删除/附件/命令/审批/事件同步 | **明确支持范围或桥功能缺失**；逐项在矩阵标注，不伪称已支持，不扩大设备权限职责 |
| 两版Math.max展开、历史rpcId丢失 | **共有缺陷/缺口**；同步内置不能修复005或完整解决003/008 |

### 安全、权限与部署边界

1. **设备授权与会话桥密钥隔离符合当前架构。** 独立桥只收内部Bearer并监听127.0.0.1；没有Android配对或设备授权逻辑。Core的 `test_dsh.py` 验证共享发现与不透传设备授权身份；诊断trace不等于账号凭据。不能把设备工具入口不在桥中算插件缺失。
2. **deployment共享会话是显式契约。** `OAI/oai-core/src/oai_core/adapters/dsh.py:1-5,16-25` 与握手均明确共享原生corpus，不向DSH发送OAI account ID。两个已认证用户看到同部署会话本身不构成已证实越权；互不信任用户须配置不同受控DSH实例/范围。
3. **Token生成和读取有真实防护。** Core `agent_registration.py:94-163` 用随机私有0600文件、拒绝不安全权限和最终符号链接、不覆盖现有密钥；`configuration.py:2604-2681` 负责dotenv/credentials同步。未打开实际凭据文件。本轮只验证合成桥密钥。
4. **请求校验先于执行。** Bearer、challenge、未知字段、请求体预算、未知会话等已有隔离测试。sessionId经解码后仍需命中宿主真实列表，不直接作为文件路径。本轮没有证实可绕过认证或借非法路径执行宿主任务。
5. **安装安全不能等同真实安装成功。** 安装器验证目标路径/属主/变更快照、使用官方锁和包管理API，失败备份并校验恢复。43个安装测试及69个Core安装配置测试通过。官方runProfilePnpm要求调用者已持锁，因此没有证据支持“这里必然重复加锁死锁”。真实首次安装、升级、卸载和故障回滚没有运行。
6. **Token轮换需完整重载链。** 独立handler捕获旧Token，修改磁盘配置不代表进程已加载；Core注册还绑定密钥摘要，已有身份/密钥变化要求显式迁移（`agent_registration.py:289-295`）。不得通过重建身份或无条件换密钥绕过。真实轮换、热重载和凭据失效窗口均未验证。
7. **没有证据证明受理后断观察会取消本机DSH任务。** 直接调用真实prompt方法验证入口后的abort仍accepted；它只在入口检查signal。观察与受理应分离，但不能把此设计建议写成本轮已复现的取消Bug。

## D. 测试证据

### 既有自动化验证

以下既有测试命令的OAI部分在测试快照 `d5b82cb...` 执行；相关Core与内置Adapter源码经Git tree比较与最终 `2417284...` 完全相同。归档后的活动生成探针与两版真实宿主探针又在最终检出 `2417284...` 运行，结果一致，日志分别为 `generation-route-probe-final.txt`、`real-host-standalone-final.txt`、`real-host-builtin-final.txt`。测试使用现有依赖，没有全量Android编译、安装新工具链或阻塞轮询CI。

| 验证 | 实际命令/入口 | 通过 | 失败 | 跳过 | 证据 |
|---|---|---:|---:|---:|---|
| 独立插件全部测试 | 隔离源码快照内 `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism` | 20 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/standalone-tests.txt) |
| 独立类型检查 | 同目录 `node node_modules/typescript/bin/tsc --noEmit` | 1次检查 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/standalone-typecheck.txt)；checkJs=false，不能视作严格JS类型契约验证 |
| OAI内置DSH四个文件 | `./node_modules/.bin/vitest run --config integrations/dsh-session-adapter/vitest.config.js` | 89 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/builtin-tests.txt) |
| Core会话/流/交互/操作恢复 | `PYTHONPATH=oai-core/src python -m pytest -q` + 下列六个文件，`-p no:cacheprovider` | 89 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/core/pytest-core.txt) |
| Core安装配置 | `PYTHONPATH=oai-core/src python -m pytest -q oai-core/tests/test_dsh_installation.py oai-core/tests/test_dsh_setup.py --basetemp=<新隔离目录> -p no:cacheprovider` | 69 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/install/install-python-tests.txt) |
| 握手错误/健康/发现隔离 | `PYTHONPATH=oai-core/src .venv/bin/python -m pytest -q oai-core/tests/test_agent_handshake_errors.py oai-core/tests/test_agent_health_recovery.py oai-core/tests/test_agent_discovery_failure_isolation.py --basetemp=<新隔离目录> -p no:cacheprovider` | 27 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/core-handshake-health-tests.txt) |
| 安装器独立复核 | 隔离复制内置 `install.test.js` 后使用Vitest执行 | 43 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/install/install-node-tests.txt)；已包含在上面89中，不重复计数 |
| 独立上游漂移检查 | `OAI_UPSTREAM_ROOT=<OAI检出> npm run verify:upstream` | 0 | 1次检查 | 0 | [日志](evidence/2026-11-11-dsh-core/upstream-drift.txt)；源码、测试、patch三项不一致，不等同三个业务Bug |

Core六个聚焦文件：`test_dsh.py`、`test_remote_stream_frames.py`、`test_remote_stream_phases.py`、`test_remote_generation.py`、`test_native_interactions_core.py`、`test_native_operation_recovery.py`，均位于 `oai-core/tests/`。

既有单元/契约测试去重合计 **294 passed、0 failed、0 skipped**。上游漂移检查另计为预期可解释的失败。独立仓库现有 `.bin` 包装器不能在本机执行，直接npm test/typecheck初次报 Exec format error；改用同一已安装包的JS入口后成功。OAI安装依赖的Vitest `4.1.10` 与manifest当前写的 `4.1.11` 不同，报告保留实际运行版本，没有做全新npm ci或声称锁文件安装验证通过。

### 最小风险复现

| 探针 | 结果 | 关键输出与范围 |
|---|---|---|
| [消息复现](evidence/2026-11-11-dsh-core/message/repro.mjs) | **13通过、0失败、0跳过** | 身份字段丢失；挂起断连/期限/终态三场景；2000 delta背压；过期取消；15万事件；真实宿主signal、cancel、rpcId去重方法；双会话隔离 |
| [Profile重启复现](evidence/2026-11-11-dsh-core/install/probe_restart_profile.py) | **1个复现断言通过** | 显式target-home/worker仍请求restart dsh.service；systemctl完全Mock |
| [活动生成路由](evidence/2026-11-11-dsh-core/core/generation-route-probe.py) | **1通过** | `{online:true,send:true,currentGeneration:"NOT_FOUND",httpStatus:404}`；真实桥处理器+真实Core传输，宿主query合成 |

这15项复现断言不与“功能验证通过”混算。消息并发测试中两个会话使用turn7/19并故意共用attemptId，增量/终态未串流，错误turn终态被忽略，监听器4→2→0；证明所测隔离路径正常，不能替代真实多Profile压力验证。

可在独立仓库运行消息复现：

```bash
node --test docs/reviews/evidence/2026-11-11-dsh-core/message/repro.mjs
```

真实宿主方法测试要求PATH中存在 `dsh`，按该CLI自己的依赖树解析模块，不读取用户配置。其余Python探针从OAI仓库执行，例如：

```bash
PYTHONPATH=oai-core/src python ../dsh-android-gateway/docs/reviews/evidence/2026-11-11-dsh-core/install/probe_restart_profile.py
PYTHONPATH=oai-core/src python ../dsh-android-gateway/docs/reviews/evidence/2026-11-11-dsh-core/core/generation-route-probe.py
```

每次pytest的basetemp使用新目录并保留证据；不要将相同目录用于会触发清空的重跑。

### 真实宿主集成与E2E边界

[真实宿主探针](evidence/2026-11-11-dsh-core/protocol/real_host_probe.py)以全新DSH_HOME启动真实CLI，仅传入合成桥Token、PATH等白名单环境，不继承模型凭据；`--no-open`关闭浏览器自动打开。每次结束均关闭本轮子进程，保留隔离数据供复核。只归档脱敏结果，不归档数据库、密钥、凭据或原始宿主带访问Token的启动日志。

| 链路步骤 | 独立插件结果 | 内置对照结果 |
|---|---|---|
| DSH启动、插件加载及真实服务注入 | 通过 | 通过 |
| 当前Core HMAC握手/签名 | 通过 | 通过 |
| 临时真实IdentityStore管理授权、注册与条目回读 | 通过 | 通过 |
| Core真实DshSessionAdapter健康/列表 | 通过 | 通过 |
| 创建、空历史、重命名、列表回读 | 通过 | 通过 |
| 无Bearer拒绝 | 401，通过 | 401，通过 |
| 提交合成文字，无模型凭据 | 进入原生处理并返回AGENT_FAILED；历史行数5 | 返回OUTCOME_UNKNOWN；历史0，符合AUD-007 |
| 停止并重新启动宿主，持久会话回读 | 通过 | 通过 |
| 真实模型生成回复、成功delta/done及完整回复历史 | **未验证/缺独立测试模型配置** | **未验证，且先受AUD-007阻断** |
| 完整Core HTTP服务、App登录与双界面交互 | **未验证** | **未验证** |
| Android真实设备能力CLI/MCP/API | **未验证/没有隔离配对设备链路** | 同 |
| 真实生成中断网、Core重启、宿主重启、热重载、Token轮换 | **未验证**；相关边界用隔离契约/方法探针覆盖部分 | 同 |
| 实际首次安装、旧Bundle升级与卸载 | **未验证**；只验证加载及安装器隔离行为 | 同 |

可从OAI检出重跑真实宿主探针（所有操作仍仅写全新隔离目录，不指向既有DSH_HOME）：

```bash
PYTHONPATH=oai-core/src python ../dsh-android-gateway/docs/reviews/evidence/2026-11-11-dsh-core/protocol/real_host_probe.py --adapter ../dsh-android-gateway/src/index.js --label standalone
PYTHONPATH=oai-core/src python ../dsh-android-gateway/docs/reviews/evidence/2026-11-11-dsh-core/protocol/real_host_probe.py --adapter integrations/dsh-session-adapter/index.js --label builtin
```

这些是**真实宿主与Core库集成证据**，不是“Android→完整Core服务→DSH→真实模型→回复”的成功E2E；也没有用Mock回复冒充真实模型。

独立审校已核对8项问题的源码、复现边界、能力责任和去重计数，未发现需要撤回或调整结论的事项，详见 [独立复核记录](evidence/2026-11-11-dsh-core/independent-review.md)。

## E. 修复优先级与后续验收

| 优先级 | 事项 | 依赖与验收 |
|---|---|---|
| P0 | 本轮未确认P0 | 不据此声明安全审计完全无漏洞 |
| P1，必须立即修复 | AUD-001关闭危险cancel；AUD-002受理/观察分离 | 第一项须先安全降级，随后再谈轮次恢复；第二项不能把unknown写成确定失败 |
| P1，必须立即修复 | AUD-006安装重启绑定所选实例 | 独立于消息开发，必须防止干扰其他Profile；禁止用真实任务测试错误停止 |
| P1，必须立即修复 | AUD-007内置prompt参数与实际宿主契约 | 是吸收内置可靠性实现前的前置修复；不能整文件盲同步 |
| P2，发布前补齐 | AUD-003稳定提交/原生消息身份 | 是未知结果、历史合并和未来恢复的基础；先建立真实来源身份 |
| P2，发布前补齐 | AUD-004有界观察缓冲、AUD-005长历史摘要 | 复用现有可靠性实现并修正共有缺陷；验证资源上限及其他会话不受牵连 |
| P2，发布前明确闭环 | AUD-008活动生成/队列恢复 | 依赖003及宿主权威生成事实；Core、桥、Android同步门禁和未知状态交互。若暂不实现，须明确限制产品支持范围，不能承诺可靠重连 |
| P2/P3，按产品承诺纳入 | 附件输入/历史回读、审批与工具事件、命令/模型切换 | 归桥协议适配与Core/Android既有接口衔接，不复制账号或设备授权；若产品宣称这些能力则发布前补齐，否则明确不支持 |
| P3，后续增强 | 持续事件同步、完整多Profile自动部署、追踪诊断、无缝Token轮换 | 保留既有会话/配置与回滚证据；明确实例身份、环境、端口后再自动化 |

修复后开发Agent应先固定宿主支持版本和三个仓库接口事实，逐项增加上述复现对应的回归断言，再使用**专用模型配置、专用DSH_HOME、专用Core身份与隔离Android设备**完成成功E2E、断网/进程重启/未知结果/取消竞态。发布门槛至少包括：所有P1关闭、消息可按真实ID关联、慢观察者有界、长历史正常、恢复状态有权威证据、未支持能力不误声明、更新不影响其他Profile且不替换原生数据。本轮没有执行这些生产修复，也没有替代用户作发布或合并决策。
