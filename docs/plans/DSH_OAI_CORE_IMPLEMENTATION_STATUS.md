# DSH 与 OAI Core 修复实施记录

更新日期：2026-11-12。目标为执行审计修复、更新本机 Core/DSH 并验证 Android 真实链路，保留原数据及能力。**整体未完成，尚未达到最终发布验收条件。** 具体证据见[审计报告](../reviews/DSH_OAI_CORE_COMPATIBILITY_AUDIT.md)，后续实施按[修复计划](DSH_OAI_CORE_REMEDIATION_PLAN.md)阶段推进。

## 已完成交付与验证身份

- 独立 DSH 最终运行实现为 `d60931342780ef73296db07d96d9b5f3687f16e1`；双桥精确取消、稳定身份、背压/大历史/规模、目标 Profile、历史占位升级及运行中重附已交付；完整 Core 与真实模型双桥各 28 项通过。
- OAI PR168、171、172、175、176 及 OpenClaw PR4 均合并；PR175 修复同进程、同 canonical 数据库文件的写入协调，PR176 仅修测试完成信号；独立两轴审查无遗留问题。#174 已关闭；不把 SQLite 修复扩展为跨 Android 进程协调。
- 最终 Android 基线为 `2caabfb1206fd93cd0232171f0bf287fdfeea498`，包含其他任务 PR161 的流式展示变化；该增量不列作本轮 DSH 实现。APK 首轮 512MiB 堆 GC 失败，恢复已有 3GiB 配置后 2 分 2 秒构建成功。
- 最终 APK 在完整 AVD 副本 `emulator-5556/user10` 覆盖成功；同签名、六包、227 项有效载荷逐字等价，仅 DEX 压缩/签名封装变化。原 `emulator-5554` 保存快照后正常停止，用户、账号、密钥、会话和历史保留；副本文件系统未扩容。
- 最终 Core 重启 run `1794458287` 通过：严格排队前提下两输入/回复各 1 次，首轮 completed，历史与 client 身份稳定、UI 稳定，全过程未观察保存失败。
- 最终真实 TCP run `1794460278` 通过：首轮运行、第二条 App 排队且宿主输入为 0 时，关闭 3 条既有连接并确认监听不可达；恢复后两输入/回复各 1 次，首轮 completed，历史/client 身份和 UI 稳定，全过程未观察保存失败。旧 TCP 失败与未知结果保护现场继续保留，不扩大为所有网络故障均通过。
- 最终 CLI/MCP 各一次只读 state 经 Android 单次本地授权、结果摘要校验、ACK、正文释放与临时凭据撤销通过；未读取屏幕节点或私人正文，不代表全部设备能力通过。
- 生产只读复核新 HMAC、原实例/scope、全部既有会话能力、单 Bundle 与 JS 摘要通过，Core Python 54/54 匹配相应源码；没有向生产提交真实消息。

## 已失败与仍开放事项

| 项目 | 最新实际结果 | 继续处理入口 |
| --- | --- | --- |
| DSH 重启队列 | run `1794460431` 为 passed=false。首轮原生 aborted，原 client 查询为 cancelled/CANCELLED；平台后来 LIVE，但 repository streamHealth 仍 FAILED、queuedSends=1、目标 unknown barrier 存在、目标 drain job 缺失；第二条无宿主输入/回复，90 秒 UI 未稳定。全过程无 SQLite 保存失败 | [OAI #179](https://github.com/1rua/open-android-intelligence/issues/179) 跟踪已复现未收敛现场，[#180](https://github.com/1rua/open-android-intelligence/issues/180) 跟踪恢复触发假设。先做 Workbench＋CoreRepo 受控红环定位，不将平台 LIVE 与仓储流 LIVE 视为同一状态 |
| 最终 Full | run `43153380070`、固定 `2caabfb1` 已 completed/failure；Android 1868 项、1 失败、1 跳过，Node 成功。失败为 `NativeAgentBackgroundWorkTest.mainWorkbenchCompletionPublishesTheExistingReplyNotification[34]`：回复 channel 多条匹配通知导致 `single` 抛异常 | [OAI #177](https://github.com/1rua/open-android-intelligence/issues/177)、[Draft PR178](https://github.com/1rua/open-android-intelligence/pull/178)。本机单方法/整类绿未证实额外通知来源；当前未完成产品或测试修复，不弱化通知身份与数量断言 |
| 旧冷启动 Full | 原 `83fbef07` Full 的联合等待失败仍未稳定复现；同 SHA 原 Release 单方法 1/1、4012ms 是另一层证据 | [OAI #173](https://github.com/1rua/open-android-intelligence/issues/173) 继续开放；当前 #177 不是原 ColdStart 重现，不以新失败或单项绿覆盖旧失败 |
| 跨故障恢复与总交付 | SQLite 修复、Core/TCP 通过已经分别有证据，DSH 重启仍未闭合，Full 仍失败 | [OAI #142](https://github.com/1rua/open-android-intelligence/issues/142) 与 [DSH #1](https://github.com/1rua/dsh-android-gateway/issues/1) 保持开放；各子 Issue 按独立关闭条件验收，不从 PR 合并状态推导总体完成 |

## 下一步与保留边界

先并行定位 #179/#180 的恢复驱动和 #177 的多通知来源，建立可控失败到修复通过的反馈环，再最小修复并独立审查。#179/#180 若同根因，用同一 PR 关联，不重复补丁；#173 独立保留。修复合并后，以同一固定提交与 APK 完成副本用户10的 DSH 重启队列验收、相关 Core/TCP 回归及最终 Full，最后更新 Issue 和总跟踪。

旧 IO/SQLite 锁、各轮 Full 失败/取消、PR175 首次远端清单与时序失败、模型 503/504/403、UNKNOWN_MODEL 及工具/前提失败均保留。旧会话未知结果屏障和原身份不删除、不换 ID、不自动重投；首轮 cancelled 按真实终态保留，只恢复权威确认可投递且尚未交付的后继条目。设备授权仍由 Core/Android 负责，不扩大 DSH 桥职责。

准确计数与白名单证据在审计报告 D 节，剩余门槛在审计报告 E 节；本文同步记录已完成、失败和未完成状态，不代替原始审计或真实终态证据。
