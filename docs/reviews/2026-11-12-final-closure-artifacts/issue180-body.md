## 现场

最终 APK、完整 AVD 副本用户10、隔离 Core/DSH/专用模型的 DSH 重启 run `1794460431`：

- 首轮运行后宿主重启，原生历史和指定 client 的 generation 明确为 `cancelled/CANCELLED`；
- 第二条 App 已进入排队，但没有宿主输入；
- 重启后 Android 平台连接状态恢复 `LIVE`；
- 只读运行态显示 `CoreAgentConversationRepository.streamHealth=FAILED`、`turns/recoveringTurns/recoveryJobs=0`、`queuedSends=1`、目标 `queueUnknownBarrier` 存在；
- 当前 Workbench 没有目标会话的 pending delivery drain job，90 秒 UI 观察没有稳定重新连接；全过程没有新的本地 SQLite 保存失败。

该结果整体保持 `passed=false`。首轮取消是权威终态，不能要求它仍产生完成回复；问题是后续已排队条目未收敛。

## 可疑调用链与待证假设

`WorkbenchController.observeStreamHealth()` 只有在 **repository 的 `streamHealth` 从非 LIVE 转为 LIVE** 时调用 `repository.retryAllPendingDeliveries()`。全局 `GatewayRuntime` 的平台 `connectionStatus=LIVE` 不等于 repository 的 `streamHealth=LIVE`。现场正是 repository 仍为 `FAILED`、平台已 `LIVE`，因此可能没有再次触发队列排空。

这只是源码和现场状态支持的可证伪假设，不能直接当成已确认根因。普通 `cancelled`→FIFO 的 CoreRepo 反馈环已通过，说明不能把所有 cancelled 恢复都归为本问题。

## 修复计划

1. 在真实 Workbench + CoreAgentConversationRepository 反馈环中预置同会话 queued delivery，令 native stream 进入 FAILED，再令平台/传输恢复但不发 repository LIVE 过渡；断言队列保持1。
2. 对照显式 repository LIVE 过渡或用户明确 retry，断言相同队列各发送一次、未知原子不重投。
3. 若红环成立，增加跨层恢复触发的最小修复；保持当前 client identity、取消终态、错误传播和未知结果保护，不清屏障、不自动重发未知输入。
4. 独立 Standards/Spec 评审、相关 Android 门禁及最终 user10/Core/DSH 复验。

本 Issue 不改变 DSH 桥职责，也不把最终 Full/真实宿主重启验收写成已完成。关联 #142、DSH 总跟踪 #1。
