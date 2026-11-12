# TCP 断网队列未知结果边界诊断

日期：2026-11-12。只读诊断；没有改生产代码、运行 Gradle、操作设备或服务。

## 现场事实

`queue-final-tcp-1794459811/public-result.json`：首轮运行时第二条进入 App 队列，故障前第二条宿主输入数为 0；关闭 4 条 TCP、监听端口不可达 12 秒。首轮输入/回复各 1，第二条输入/回复均 0；无保存失败，最终 UI 稳定，结果 `passed=false`。

当前该结果只能证明第二条没有在可见宿主历史中出现，不能证明请求从未进入 Core/DSH，也不能证明第二条 POST 未在连接前或写入前失败。当前 App 的 `AgentSessionException` 只有 `code/status`，没有接纳阶段字段。

## 可控合成证据

在最终 `2caabfb` 的 `gateway-client` 编译类上运行临时 Kotlin 探针，未联网，使用三个合成连接阶段：

```text
ADMISSION_PROBE mode=factory_failed connects=0 requestBodyBytes=0 result=OUTCOME_UNKNOWN causePreserved=false phases=transport.io_queued,transport.io_dequeued
ADMISSION_PROBE mode=connect_refused connects=1 requestBodyBytes=0 result=OUTCOME_UNKNOWN causePreserved=false phases=transport.io_queued,transport.io_dequeued,transport.connect_started
ADMISSION_PROBE mode=response_lost_after_write connects=1 requestBodyBytes=62 result=OUTCOME_UNKNOWN causePreserved=false phases=transport.io_queued,transport.io_dequeued,transport.connect_started,transport.connect_ready,transport.write_started,transport.write_completed
```

这三个结果均由 `AgentSessionClient.send()` 转换为 `OUTCOME_UNKNOWN`，底层 cause 均未保留；阶段日志只在允许的 `OaiE2E` 诊断开关下存在。临时源和输出仅留在隔离探针目录，不属于仓库提交。

源码边界：`GatewayTransport.consumeResponse()` 没有 `beforeDispatch` 栅栏；`AgentSessionClient.send()` 捕获任意 `IOException` 后统一抛 `AgentSessionException("OUTCOME_UNKNOWN")`。因此当前不存在可供 Android 安全使用的 `NOT_SENT` 或 `NOT_ACCEPTED` 通路。`GatewayTransport.execute()` 的 `beforeDispatch` 只用于带明确持久化栅栏的普通请求，不能推导流式 POST 的发送阶段。

## 队列保护路径

Core/Android 的队列逻辑已经把该场景当作未知结果处理：

- 队列排空先从 `queuedSends` 取出一项，再调用 `submitMessageForAgent`。
- 流中断或未知错误增加 `queueUnknownBarriers`，保留原 client 身份，不自动新建消息 ID。
- `retryPendingDeliveries()` 查询会话的 current generation；running/queued/unknown 时继续停留，明确空闲且该项仍在待发队列中时才排空。已经转成未知发送原子的项目通过 `retryPendingSubmissions()` → `recoverOrdinary()` → `queryMessage()` 查询原 client；两条入口不能混用。
- DSH 重新观察和 reattach 测试覆盖“同身份观察共享一次提交”“全观察断开无接纳事实时 UNKNOWN 且不重投”“迟到 native user 事实恢复”。

因此 `generation=null + history=0` 只能作为“当前没有可见活动轮次/历史证据”的结果，不能被解释为绝未受理。

## 明确拒绝与未知的区别

DSH 在已有不同 client 的活动声明且 observer 存活时，可在本次 `controller.prompt` 前返回 `SESSION_BUSY`；宿主返回明确 `accepted:false` 时，流内可返回 `AGENT_REJECTED`。这两种都没有贯穿保存为 Android 可查询的统一拒绝事实。

Core 的 admitted 只表示操作已登记，随后才进入 adapter；Remote 的连接失败/超时只统一映射 `AGENT_UNAVAILABLE` 与受限 reason；Core 操作账本只有 pending/resolved/unknown 三态，未记录“准备调用宿主/已调用/明确未调用”。

## 现有测试的可证伪入口

既有 DSH `integrations/dsh-session-adapter/reattach.test.js` fixture 已覆盖稳定 client：`prompt` 返回 accepted，但暂不写 native user/event；观察结束后仍为 `OUTCOME_UNKNOWN`，指定 generation/history 为空，同身份再次观察不重投，迟到接纳后才恢复。这直接反证“空 generation 与空 history 足以证明未接纳”。

Core/Android 现有 `CoreAgentConversationRepositoryTest.reconnectDoesNotDrainQueueUntilTheHostGenerationSnapshotIsIdle` 也覆盖：首条流断开后变为 UNKNOWN，队列仍保留；generation 继续 running 时不发送，明确为 null 后才排空。

## 结论与下一步

本次短任务现场是一个已知的保护边界：后继消息的请求结果无法确认，系统保留原身份并停止自动重发。它揭示了“跨 Core/Remote/DSH/Android 缺少 not-sent/not-accepted 结果字段”的能力缺口，但不能单独证明产品错误地丢弃了一个可确定未发送的队列项。

下一步只读验证应对齐同一 client 的：`T1.request_started`、transport connect/write 阶段、Core `operation.committed`、DSH `host_submitted`/native user 事件、以及指定 generation/history 查询结果。只有这些证据能把“连接前未发送”“已写入但响应丢失”“桥明确拒绝”分开。当前不应清除 barrier、替换 client ID 或自动重发。
