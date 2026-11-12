## 已复现现场

固定 OAI `2caabfb1206fd93cd0232171f0bf287fdfeea498`、最终同签名六包 APK、完整 AVD 副本用户10、隔离 Core/DSH/专用模型。原会话和账号数据保留，不接入私人正文。

`queue-final-dsh-1794460431`：

1. 第一条运行中，第二条在App排队，宿主第二输入数为0。
2. 受控重启真实 DSH；原生日志 turn/end=aborted，对原client查询得到 cancelled/CANCELLED，当前generation=null。
3. 第一输入1、未重投；第二条仍无原生受理、无回复。
4. 90秒UI观察未稳定连接；随后JDI只读确认平台已LIVE，但目标队列仍有一条QUEUED，目标unknownBarrier仍存在，turn/recovering/recoveryJobs全0，目标pendingDeliveryDrainJob不存在。
5. checkpointFailure=null，全程没有OaiPersistence失败；这不是已修#142的SQLite锁异常复发。

## 预期

宿主中止任务应保留准确cancelled终态；已排队且从未投递的后续条目只有在权威查询确认可投递后继续各一次。未知已发送原子仍保护，不清屏障、不换ID重投。

## 当前判断与计划

确认现场队列未收敛；根因仍需可控红环。源码中 `retryPendingDeliveriesFor` 在probe失败后加屏障返回，`schedulePendingDeliveryDrain` 只在部分事件调用；可能存在恢复后缺少再次驱动，但暂不把假设作为已确认根因。普通cancelled→idle的实际Core仓储反馈环已绿，单纯cancelled不能复现。

下一步用真实Workbench+CoreRepo，在宿主权威cancelled已可读时让一次currentGeneration probe失败，随后恢复连接而不导航/不点重试，确认是否永久停队列；同时排除旧会话屏障、completed Job槽及所有权代次。受控红成立后独立分支/PR最小修复，不自动重新POST结果未知输入。

## 验收

- [ ] 可定位根因与红绿反馈环，不混用普通cancelled绿或其他unknown退避复现。
- [ ] 目标会话/Agent隔离，不因另一会话的屏障阻塞。
- [ ] 权威终态及连接恢复后未交付队列继续各1；unknown已发送条目不重投。
- [ ] 断网、Core/DSH重启、并发恢复与资源释放回归通过。
- [ ] 原隔离现场同身份复验、全过程无存储失败，准确保留中断终态。

关联 #142、DSH总跟踪 `1rua/dsh-android-gateway#1`；本项不扩大DSH桥职责。
