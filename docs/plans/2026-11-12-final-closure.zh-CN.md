# DSH 与 OAI Core 最终收口

日期：2026-11-12。总跟踪：[DSH #1](https://github.com/1rua/dsh-android-gateway/issues/1)。**本轮整体尚未完成。** 本文给出剩余工作顺序；固定事实、原始失败和白名单证据在[审计报告](../reviews/DSH_OAI_CORE_COMPATIBILITY_AUDIT.md)中保留，具体实现阶段与职责见[修复计划](DSH_OAI_CORE_REMEDIATION_PLAN.md)。

## 已完成的具体范围

PR175 合并 `473fb735ebdc85814179375997b9193b0fccb25f`、PR176 合并 `a400ee88b2bed7ed2dfd0cc9648353de657879b7`；独立两轴审查无遗留问题，相关门禁通过，#174 已关闭。最终 `2caabfb1` APK 已实际构建、同签名六包/227 项有效载荷校验，并在授权完整 AVD 副本用户10保留数据覆盖。Core 重启 run `1794458287` 和真实 TCP run `1794460278` 均满足首轮 running、第二条排队且故障前宿主输入为 0 的前提，恢复后两输入/回复各 1 次、身份稳定、UI 稳定、全过程无保存失败。CLI/MCP 各一次只读 state 的本地授权、摘要、ACK 与释放通过；生产新 HMAC、单 Bundle、54 个 Python 源和 JS 摘要复核通过。

这些结果各有固定范围，不扩展成所有模型、所有故障或全部设备能力已验证。原模拟器、原账号、密钥、原生会话与历史保留；副本文件系统未扩容，也没有通过清数据取得通过。

## 仍未完成的关闭条件

| 事项 | 当前事实 | 关闭前必须完成 |
| --- | --- | --- |
| DSH 重启队列，[OAI #179](https://github.com/1rua/open-android-intelligence/issues/179)、[#180](https://github.com/1rua/open-android-intelligence/issues/180) | run `1794460431` 未通过：首轮准确 cancelled；平台恢复 LIVE，但仓储流 FAILED、后继仍排队、目标 drain job 缺失；全过程无本地保存失败 | 用真实 Workbench＋CoreRepo 红环证明恢复触发根因，最小修复并保留未知结果屏障；同一固定提交 APK 的原隔离现场复验确认首轮取消终态准确、未交付后继各执行一次、UI/队列收敛 |
| 最终 Full，[OAI #177](https://github.com/1rua/open-android-intelligence/issues/177)、[Draft PR178](https://github.com/1rua/open-android-intelligence/pull/178) | `43153380070` 在 `2caabfb1` 已 completed/failure；Android 1868 项、1 失败、1 跳过；原生完成通知测试因同 channel 多通知匹配使 `single` 抛异常 | 固定通知数量与目标身份的受控红环，区分产品重复通知和测试夹具迟到任务；保持原断言，独立审查和相关门禁通过后，以修复后的固定提交重新取得 Full 成功终态 |
| 原冷启动门禁，[OAI #173](https://github.com/1rua/open-android-intelligence/issues/173) | 旧 `83fbef07` Full 联合等待失败与本地单项 4012ms 成功均保留；未稳定复现根因 | 与 #177 分开定位；不放宽断言/预算，不以单项补跑替代最终 Full 中对应测试的实际执行和独立关闭依据 |
| 跨故障恢复与总跟踪，[OAI #142](https://github.com/1rua/open-android-intelligence/issues/142)、DSH #1 | SQLite 修复已交付、Core/TCP 已通过，DSH 重启与 Full 尚未收敛 | 各子 Issue 按范围完成关闭；最终报告、计划、实施状态和 Issue 状态一致，再关闭总跟踪。只完成文档交付时，仍保留总跟踪 open |

## 执行顺序

1. 并行诊断 #179/#180 和 #177；各自独立工作区、Draft PR、受控红绿与中文提交。#179/#180 若确认同根因，用一个最小补丁关联两项；PR178 目前仍为诊断计划，不能提前当作修复完成。
2. 修复前核对新证据是否支持原假设；复核取消、未知结果、多会话隔离、通知身份和资源释放。不得删除 unknown barrier、换 client ID、自动重新 POST 未知输入，或把 cancelled 改写为 completed。
3. 独立 Standards/Spec 审查并通过相关聚焦门禁后合并；再固定最新 dev、APK、签名与运行身份，使用保留数据的完整副本用户10验收 DSH 重启，同时回归已通过的 Core/TCP 行为。
4. 后台触发并读取同一固定提交的最终 Full 终态，保留全部旧失败/取消/跳过数，不用 PR 绿或本机单方法绿替代。#173 依其独立范围更新，不因 #177 关闭而自动关闭。
5. 更新四份文档与白名单清单，检查相对链接、原始审计逐字保留和脱敏，再独立复核文档、回读远端 Issues/PR/CI。#142、#173、#177、#179、#180 与 DSH #1 只按各自关闭条件收口；#174 已关闭，不重复列为待修。

最终结果统一补录到[审计 E](../reviews/DSH_OAI_CORE_COMPATIBILITY_AUDIT.md#e-剩余门槛与下一入口)，再同步本文件和实施状态。设备能力调度/本地授权继续由 Core/Android 负责；附件、命令/模型切换、结构化工具/审批、归档删除、eventSync、跨 Android 进程锁、任意故障精确一次和官方 DSH 图形界面仍按原支持或未验证边界陈述，不扩大本轮职责。
