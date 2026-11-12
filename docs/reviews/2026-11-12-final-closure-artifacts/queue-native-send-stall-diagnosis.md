# 新模型切换后原生会话发送停留的只读诊断

日期：2026-11-12。本子任务只审读源码、编译只读 JDI 探针及读取主任务提供的脱敏形状证据，没有运行 Gradle、操作设备、重启服务或发送模型请求。源码使用隔离检出，HEAD `f57f8ae918134a271aba0ca87feb7f00ffd379ae`；已执行差异核对，它与保存锁修复合并 `473fb735` 在 `apps/android`、`oai-core`、DSH adapter 范围没有差异。

## 已确认

主任务的 `queue-io-jdi/runtime-queue-state.txt` 显示：

- 原生 Agent 发现已成功，`supported=true`、`selectionConfirmed=true`、Agent 为专用合成 `dsh-e2e`，发现错误为空。
- 工作台实际仓储为 `CoreAgentConversationRepository`，`authoritativeMessageIds=true`、`supportsMessageBatches=false`。
- `phase=Connected`、平台 `connectionStatus=LIVE`；工作台 `historyHydrated=true`、`isOnline=true`、`sendSupported=true`、`composer=EDITING`、`generation=FAILED`、`streamHealth=FAILED`。
- `pendingSubmission=null`，`failedSubmission` 保留，`pendingBatch=1`，`pendingDeliveries=0`；`activeWork.submissions=0`。
- `checkpointFailure=null`、检查点任务内部状态为 `Unit`、持久化 mutex 可用许可为 `1`。
- 仓储 `turns/recoveringTurns/detachedRecoveringTurns/queuedSends/recoveryJobs` 全为零；`queueUnknownBarriers=1`。

这排除了本次现场“恢复缓存丢失原生模式、自动切旧 `/conversations` 仓储”的推测，也没有显示保存异常、持久化锁阻塞或活动发送任务。主任务另以新会话短请求验证当前模型可用，属于独立宿主证据，不能推导旧 client 的结果。

## 文案与真实路由不能混用

`WorkbenchScreen.kt:656` 对所有 `state.pendingBatch` 渲染 `PendingBatchStrip`；`ComposerBar.kt:962` 固定显示“条 · 等待合并”。原生普通发送在提交前也会把本地占位加入 `pendingBatch`（`WorkbenchController.kt:3293,3433`），不需要批处理能力。“等待 Gateway 接收”仅表示占位 `pendingAcceptance=true` 且 `batchGroupId=null`（`MessageTimeline.kt:974`）。这些文案不能证明 classic fallback。

常规恢复每次在 `GatewayRuntime.kt:1847` 重新协商，`:2115-2119` 明确传入 `negotiated.nativeAgentSessions`，没有从持久化缓存恢复该布尔值。标志真实名称为 `X-OAI-Agent-Sessions: 1`；Core `server.py:249-261` 成功协商后固定添加，Android `NegotiationClient.kt:231-233` 精确解析。该方向已由现场对象类型排除。

全局“正在连接”来自独立平台流 `platformStatus.status`（`GatewayRuntime.kt:3223-3227`），可与 `phase=Connected` 并存；不能反推消息仓储或宿主轮次。最新 JDI 该值已为 LIVE。

## 503、Busy 与未知保护的边界

`CoreAgentConversationRepository.kt:1567-1586` 按固定错误码区分：`AGENT_UNAVAILABLE`、`OUTCOME_UNKNOWN` 等进入按原身份恢复；`AGENT_FAILED` 在已有权威 user ID 且支持恢复时也进入恢复；`SESSION_BUSY` 未列入该组，进入失败状态投影。finally 会移除本次 live turn；故历史失败后 turn 计数为零并不矛盾。

`queueUnknownBarriers` 仅直接阻止 `drainQueuedSends`（`:1653`）。新的普通 NORMAL 提交不会检查它，且可将旧未知轮次转入 detached 恢复（`:1290-1312`）。它也不能独自解释普通新消息在本地完全不发送。当前 `queuedSends=0`，`retryPendingDeliveries` 对空队列会提前返回，不能依靠它清除此屏障。

桥中 `SESSION_BUSY` 的明确入口为 `integrations/dsh-session-adapter/index.js:308-315`：同会话已有不同 client 的提交声明且 `observers.size>0`。该判定不读取当前 generation，因此宿主尚未发布该 client 的原生 user 事实、但旧观察仍存活时，可以同时出现 Busy 与 current generation=null。观察数为零、已提交但仍未知的声明会保留并返回 `OUTCOME_UNKNOWN`，而非伪造已空闲。当前现场是否存在这种旧 claim 尚未采到，仍是假设。

`index.js:16` 默认受理等待为 30 秒、观察上限为 30 分钟；Core 的 producer 与 App 观察连接独立（`sessions.py:1060-1098`）。因此 App 仓储的 turn 已归零，仍不足以证明 Core 到桥的旧 observer 已归零。不能直接删除 busy claim 或将空 current 解释成旧请求未提交。

## 应先按原身份查询

`failedSubmission` 与 `pendingBatch=1` 不能证明原请求从未投递。无参数 current generation=null 只证明没有当前活动轮次，不能证明某个 client 没有执行过。

现有显式恢复路径为 `retryPendingSubmissions()` → `recoverOrdinary()` → `CoreAgentConversationRepository.queryMessage()` → `AgentSessionClient.generation(...原client...)`。指定原 client 的 generation 返回 null 会抛 `OUTCOME_UNKNOWN`（`AgentSessionClient.kt:207`），查询失败保持原发送原子的未知状态，不发送新 POST。持久 receipt 或原生历史命中后才补齐原身份事实。普通发送在草稿未被改动且匹配 `failedSubmission` 时也会复用原 client 并先查询；脚本更改 marker 会形成新的明确输入，不能把它当成旧请求重试证明。

最小下一步由主任务只读采集 `failedSubmission.clientMessageId`（仅合成身份）、对应发送原子的 `submissionState/status/statusRevision/submissionErrorCode`、是否仍为客户端占位 ID，然后读取指定原 client 的 generation 与历史存在性。只报告 state、revision、身份匹配布尔，不读取正文或凭据。不清理屏障、不修改 ID、不重复 POST。

## 另一个独立通知补偿问题

通知的 `isRunning` 包含 QUEUED/RUNNING/DISCONNECTED；缺有效同轮终态时可保留。当前生产装配 `NotificationConversationReconciler(... ConversationClient(platformHttp))`（`GatewayRuntime.kt:3170`）仍查询旧 `/conversations` 路由，而 Core 明确拒绝它；仓库存在原生核对器但生产未装配。因此通知漏终态可能不能通过该补偿收敛。另需核对固定 revision=1 的本机失败事件是否被已有更高修订挡住。

但这条通知路径不是本次发送准入根因：`externalBusyThreadIds` 仅影响会话管理与 UI busy 集合（`WorkbenchController.kt:1338,6094`），`canSend` 和 `sendDraft` 不读取它；现场 `busyThreadIds=0`。不得因该静态问题就把当前发送停留归因通知 busy。

## 探针限制

`RuntimeQueueStateProbe.java` 读取字段、计数、固定枚举和允许的错误前缀，不调用目标方法、不读取消息/草稿。它不暂停整个 VM；并发计数是近似快照。第一次输出 `repo._generationId=PRESENT_REDACTED` 只表示底层状态是对象，Kotlin 的 null 也可能由内部 Symbol 表示，不能把这个字样当作非空轮次 ID。

主任务授权后探针已增补原合成 `failedSubmission` 的 client/conversation/expectedGeneration ID、delivery/revision，只匹配对应发送原子并输出 submissionState/status/修订/占位布尔，不读取 `parts`、草稿或正文。同时识别固定 NULL 类 Symbol，并输出 `nativePendingSubmissions` 计数。已用 JDK21 javac 编译通过，真实运行由主任务独占；本子任务没有连接设备。
