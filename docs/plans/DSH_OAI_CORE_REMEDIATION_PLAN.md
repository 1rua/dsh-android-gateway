# DSH 与 OAI Core 修复计划与验收门槛

制定日期：2026-11-11；实施状态更新：2026-11-12。总跟踪：[DSH #1](https://github.com/1rua/dsh-android-gateway/issues/1)。原始问题及修复前计划以[完整审计保留段](../reviews/DSH_OAI_CORE_COMPATIBILITY_AUDIT.md#原始审计完整保留)为历史基准。本文区分已经交付的修复、实际通过的场景和仍需完成的工作，**整体尚未完成**。

## 目标与不变条件

保持 Android App ↔ OAI Core ↔ DSH Adapter ↔ DSH 架构，修复 AUD-001—008 及实施中发现的兼容性与恢复问题，保留账号、密钥、实例、配置、原生会话、历史和现有能力。未知结果屏障用于防止重复执行，不能删除屏障、换 `clientMessageId` 重投或把 `cancelled` 改成 `completed` 来取得通过结果。附件、原生命令、工具/审批、归档删除和 eventSync 不在本轮新增范围。

## 已交付与最新验收事实

| 阶段 | 已交付或实际结果 | 验收边界 |
| --- | --- | --- |
| 基线与注册 | 对齐独立 dev，有选择地引入现有握手与测试 | 不以同名本地分支代替远端基线，不整体覆盖 main 的无关配置 |
| 原 P1 与双桥可靠性 | 精确取消、受理/观察分离、宿主 signal、所选 Profile 重启 | 双桥真实宿主与非目标活跃任务有证据；双 systemd unit 仍未验证 |
| 身份、资源、规模 | 稳定 native/client 身份、背压、长历史、305 会话查询、内部来源过滤、Android 历史占位升级 | 受控验证与 Android 原数据验证分别记录，不扩展为任意正文或插件规模 |
| 权威恢复与重附 | current/generation 能力门禁、未知结果屏障、运行中观察重附 | 完整 Core 与真实模型双桥各 28 项；不承诺任意故障下普遍精确一次 |
| 后续修复 | PR168 通知来源、PR171 夹具日志、PR172 契约 pin、PR175 同库锁协调、PR176 通知测试完成信号均已合并 | 独立两轴审查无遗留问题；PR175 仅覆盖同进程、同 canonical 数据库路径，PR176 生产源码零变更 |
| 最终 APK 与设备通路 | 固定 `2caabfb1206fd93cd0232171f0bf287fdfeea498`；同签名、六包、227 项有效载荷校验；完整 AVD 副本用户10保留数据覆盖；CLI/MCP 各一项只读 state 全链通过 | 原模拟器保留快照并正常停止；副本文件系统未扩容；设备结果不代表全部能力通过 |
| 最终 Core 重启与 TCP | Core run `1794458287`、TCP run `1794460278` 均通过；两输入/回复各 1 次，身份和历史稳定，全过程未观察到保存失败 | 两场景均先确认首轮 running、第二条在 App 排队且宿主输入数为 0；TCP 实际关闭 3 条既有连接并确认监听不可达 |
| 最终 DSH 重启 | run `1794460431` 未通过：首轮权威状态为 `cancelled/CANCELLED`，平台恢复 LIVE，但第二条仍排队、仓储流为 FAILED、目标 drain job 缺失 | 全过程无本地 SQLite 保存失败；不能归为 PR175 的锁异常复发，也不能用 Core/TCP 成功替代 |
| 最终 Full | run `43153380070`、固定 `2caabfb1` 为 completed/failure；Android 1868 项、1 失败、1 跳过；Node 成功 | `NativeAgentBackgroundWorkTest.mainWorkbenchCompletionPublishesTheExistingReplyNotification[34]` 因回复 channel 多条匹配通知使 `single` 抛异常；本机单项通过不能替代 Full |

具体计数、固定源码与白名单证据见[审计 D](../reviews/DSH_OAI_CORE_COMPATIBILITY_AUDIT.md#d-分层验证真实失败与数据保留)。旧 503/504/403、UNKNOWN_MODEL、输入工具错误、前提不成立和各轮 Full 失败继续保留。

## 剩余阶段、依赖与验收

#177、#179、#180 按现有记录作为 P2 跟踪；#173 沿用其现行记录，不因最终验收未通过而擅自升级。阶段一与阶段二可在独立工作区并行；最终全链复验和 Full 必须使用两项必要修复合并后的同一固定提交及对应 APK。

| 阶段与关联 | 责任与执行范围 | 可执行步骤与依赖 | 验收及关闭条件 |
| --- | --- | --- | --- |
| 一：DSH 重启后的队列收敛，[OAI #179](https://github.com/1rua/open-android-intelligence/issues/179)、[#180](https://github.com/1rua/open-android-intelligence/issues/180)，归入 [#142](https://github.com/1rua/open-android-intelligence/issues/142) 的跨层恢复验收 | Android 的 `CoreAgentConversationRepository` 与 `WorkbenchController` 负责恢复驱动、队列及观察状态；Core/双桥继续提供真实活动/终态事实 | 先建立真实 Workbench＋CoreRepo 受控红环：预置未投递后继条目，首轮恢复为权威 cancelled，令 repository streamHealth 保持 FAILED，而 Runtime 平台恢复 LIVE；不导航、不点重试，观察队列是否停留。对照 repository LIVE 过渡或显式 retry，确认相同条目各发送一次。再排除一次 currentGeneration probe 失败、已完成 Job 槽、会话/Agent 隔离及恢复代次的影响；根因成立后才做最小修复 | 同一目标会话权威终态可读且连接恢复后，未交付后继条目自动继续且各执行一次；原未知已发送条目不重投，取消终态保留；相关断线、取消竞态、多会话、资源释放回归和原 user10 DSH 重启复验通过。#179 是现场缺陷，#180 是恢复触发假设；若同根因，用同一 PR 关联两项，不重复实施独立补丁，不在根因未证实时直接关闭 |
| 二：最终 Full 的回复通知失败，[OAI #177](https://github.com/1rua/open-android-intelligence/issues/177)、[Draft PR #178](https://github.com/1rua/open-android-intelligence/pull/178) | OAI Android 通知发布和测试夹具生命周期；不归因于 DSH 桥 | 固定 `2caabfb1` 与 FullDebug/SDK34 原失败方法，记录匹配通知的数量与目标身份；受控证明额外通知来自旧 fixture 的迟到任务、不同目标混入或产品重复发布。根据红环分别修产品或测试清理/等待边界；保留原生 Agent、会话、代次、bubble 和非 ongoing 等原断言 | 可定位根因、受控红绿、原方法及相关整类回归、独立 Standards/Spec 审查、对应门禁通过；不把 `single` 改成宽松断言来掩盖多通知。PR178 目前只有计划，未完成修复，最终 Full 通过前不关闭 #177 |
| 三：独立保留冷启动门禁，[OAI #173](https://github.com/1rua/open-android-intelligence/issues/173) | OAI Android 前台连接恢复及其测试时序 | 继续固定旧 `83fbef07` 失败与单方法 4012ms 成功的各自来源；若可稳定复现，记录连接数、平台 LIVE 终值和测试完成信号，区分产品与夹具根因，再最小修复 | 当前 #177 的失败不是 #173 重现。不得放宽 10 秒联合等待或其他预算；#173 关闭须有独立根因/稳定性证据和后续固定提交 Full 对应测试实际执行成功，不能由本机单项绿代替 |
| 四：固定提交的真实恢复与发布门禁 | 主任务整合；Android/Core/双桥各自负责现有接口，不扩展 Adapter 职责 | 依赖阶段一、二所需修复及独立评审完成；更新保留数据的 AVD 副本 APK，再执行严格排队前提的 DSH 重启，回读原 client 身份、原生输入/回复次数及全过程保存日志；关联回归确认 Core 重启与 TCP 已通过行为保留。随后后台触发并取得同一提交 Full 终态 | DSH 重启首轮准确 cancelled，未投递后继条目各执行/回复一次，UI/队列收敛，无保存失败、无重复投递；Full 实际 completed/success，保留此前失败和跳过计数。只在相应条件满足后更新 #142；#173、#177、#179、#180 各按自己的关闭条件处理 |
| 五：报告与总跟踪收口，[DSH #1](https://github.com/1rua/dsh-android-gateway/issues/1)、文档 PR16 | DSH 文档与证据纳管，生产源码不在本次文档提交内 | 补录实际结果，重新回读 Issues/PR/CI；四份文档、白名单清单、相对链接、原始审计逐字保留均经独立 Standards/Spec 审查；修复计划与报告状态一致 | 先闭合必要产品与门禁条件，再关闭总跟踪；不能从已合并 PR 推导整个目标完成。若仍有失败或未验证项，文档可以按真实状态交付，总跟踪继续 open |

首轮源码与回归范围以下列 OAI 仓库相对路径为入口；扩展范围须由新证据说明，不能先整模块重构：

- 队列恢复：`apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/conversations/CoreAgentConversationRepository.kt`、`apps/android/conversation-ui/src/main/kotlin/com/openandroidintelligence/conversation/state/WorkbenchController.kt` 及 `apps/android/app/src/test/kotlin/com/openandroidintelligence/mobile/conversations/CoreAgentConversationRepositoryTest.kt`。先覆盖“平台恢复 LIVE、仓储仍 FAILED”的反馈环，再决定生产改动位置。
- 完成通知：`apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/NativeConversationNotifications.kt`、`apps/android/app/src/test/kotlin/com/openandroidintelligence/mobile/NativeAgentBackgroundWorkTest.kt`、`apps/android/app/src/test/kotlin/com/openandroidintelligence/mobile/NativeConversationNotificationsTest.kt`。通知目标、数量和 fixture 退出后的异步任务应分别断言。
- 冷启动：`apps/android/app/src/test/kotlin/com/openandroidintelligence/mobile/ColdStartConnectionTest.kt`；只有证据指向生产前台连接路径时才扩展生产修改。聚焦验证复用现有依赖、JDK21/SDK36 与 Gradle 缓存，随后执行相应 `npm run test:fast`、`npm run test:pr` 门禁；最终 `npm run test:full` 作为独立整体验收。

## 提交、数据保留与职责边界

当前文档提交只改 docs；后续产品修复已获授权，仍须先关联 Issue，从最新 dev 建独立 worktree/任务分支与 Draft PR，按中文提交规范仅暂存本次文件。提交前完成必要聚焦测试与独立 Standards/Spec 审查，再转正式 PR 并跟进远端门禁。远端 CI 使用后台或单次状态读取，不执行阻塞 watch。

#142、#173、#177、#179、#180 与 DSH #1 继续开放；#174 已关闭，不重复列为待修。#142 的 SQLite 修复已交付，但跨故障队列恢复仍有未完成验收，不能清除历史失败或未知结果屏障来关闭。设备发现、认证、调度属于 Core，设备本地授权与执行属于 Android；桥只映射宿主会话和生成事实，不新增账号、Gateway 或设备权限系统。

证据只纳管类型、状态、计数、摘要和相对源码引用。账号、Token、密钥、数据库、原始正文/屏幕、APK、完整 CI 日志不入库；实际配置仅引用现有专用测试配置。原模拟器及原生数据保持保留，测试使用已授权完整副本和隔离合成会话。
