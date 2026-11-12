# DSH 宿主重启后取消终态与后继队列未排空

日期：2026-11-12。只读诊断；未修改生产代码、未运行 Gradle、未操作模拟器或服务。

## 现场状态

`queue-final-dsh-1794460431/public-result.json` 显示：首轮输入/回复各 1，宿主重启后首轮状态为 `cancelled`；第二条输入/回复均为 0；全过程没有 SQLite 保存失败，但通道持续断开，最终 `passed=false`。主任务的 keyed JDI 状态进一步显示：

- `repo.queuedSends` 仍有 1 项，状态 `QUEUED`；
- 该项属于当前合成会话，不是旧 1889 会话；
- 当前会话 `queueUnknownBarrier` 存在；
- 当前会话没有 `turns/recoveringTurns/detachedRecoveringTurns/recoveryJobs`；
- `pendingDeliveryDrainJobs` 只有旧会话的一项且已经完成，当前会话没有对应 drain job；
- `activeWork=1`，对应后继 client；
- 全局 `connectionStatus=LIVE`、平台 `phase=Connected`，但工作台 generation/stream health 为 FAILED。

这不是“后继已取出、请求未知后 queue=0”的路径；后继仍在 `queuedSends`，因此现场缺口更接近“取消终态后没有为当前会话重新触发排队排空”。

## 源码时序

Core 仓储在 legacy generation 恢复中读取精确 generation 和历史，若 receipt 为 `cancelled`，会生成取消事实；恢复完成后 `markSettled`、清理恢复持有者和 barrier，随后在 `startRecovery` finally 中调用 `drainQueuedSends(turn.agent, conversationId)`。本地合成探针已验证这条最小链：取消 receipt + history → 后继消息 FIFO 发出，selected conversation 和切换到其他 conversation 两种情况都通过。

因此单纯 `cancelled` 终态与同一 Agent owner 不会复现当前现场。现场还有一个重要差异：第二条仍在 `queuedSends`，说明恢复完成后针对当前会话的 drain 没有真正启动，或 drain 的触发任务属于旧会话。

运行时恢复路径 `GatewayRuntime.restoreNativeReads()` 只调用仓储 `connectionRestored()`；`resumeWorkbench()`/`onForegrounded()` 会重启事件流、刷新列表和时间线，但没有直接调用当前控制器的 `retryPendingDeliveries()`。Workbench 的 `schedulePendingDeliveryDrain()` 主要由当前会话收到终态事件时调用。若取消事实在仓储恢复中被合成并落盘，却没有作为当前工作台事件投影到该会话，便可能出现“Core 已知道 cancelled、队列仍留在当前会话、LIVE 恢复没有新的 drain 触发”的状态。

## 其他可达失败边界

若确实执行了 drain，`drainQueuedSends` 会先 `takeQueuedSend()` 移除队首，再异步启动真实发送。首个取消恢复不检查发送能力是否已恢复；旧 `CoreAgent` 快照可能仍显示在线，但 DSH/Core 此时可能返回 `AGENT_UNAVAILABLE`、`UNSUPPORTED_CAPABILITY` 或其他异常。异步失败会加 barrier，而队列项不会由外层同步 catch 放回。该路径会得到 queue=0、barrier=1，和 0431 的 queue=1 不同。

`queueUnknownBarriers` 是按 `(agentId, conversationId)` 隔离的；现场同时存在旧会话 1889 和当前会话的 barrier，不能按总数判断当前会话是否已解锁。必须按 key 读取。

## 可证伪受控红环

不改生产的最小测试应使用真实 `CoreAgentConversationRepository` + 合成传输：

1. 首轮返回明确 `cancelled` generation receipt 和对应历史，后继先写入当前会话 `queuedSends`；
2. 让仓储恢复完成并提交取消事实，但不让 Workbench 接收到当前会话的 `GenerationCancelled` 投影；
3. 只调用 `connectionRestored()`/模拟平台 LIVE，不调用 `retryPendingDeliveries()`；
4. 断言当前会话 queue 仍为 1、没有第二条 POST；
5. 单独调用当前会话的 `retryPendingDeliveries()` 或投递明确取消事件，断言 FIFO 后继发出一次。

该红环若成立，问题是“恢复终态未唤醒当前 Workbench 队列排空”，不是取消终态本身错误。若不成立，再注入发送阶段的 `AGENT_UNAVAILABLE`/`UNSUPPORTED_CAPABILITY`，检查 queue=0、barrier=1 的另一条路径。

当前不应清除 barrier、改变 client ID、或在没有权威终态/发送能力时强制重投。宿主重启脚本原先严格要求 `completed` 也应与允许 `cancelled` 的协议语义分开；但 0431 的第二条仍为 0 条输入，故即使承认首轮取消，队列闭环仍未完成。
