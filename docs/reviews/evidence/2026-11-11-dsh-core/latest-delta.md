# 最新 OAI dev 差异复核

本轮审查开始时的 OAI dev 为 `d5b82cb6f796a08838f3a1136b8fbb77e22c0f49`；收尾重新读取远端后改为 `24172841f9a564c53416f7d066f3450d4feb2bfe`。已在隔离 checkout 确认 HEAD 等于后者，工作区干净。两者之间只增加提交 `24172841f9a564c53416f7d066f3450d4feb2bfe`：`重构: 文案资源集中管理以符合安卓标准`。本次复核覆盖该提交对审计链的影响，不将审计开始时的 SHA 冒充当前最新版本。

## 核心代码未变的 Git 对象证据

| 范围 | 旧提交 Git tree | 最新提交 Git tree | 结论 |
|---|---|---|---|
| `oai-core/` | `cbd39c00de0a696136d8f73f6c9e5a25e404a310` | `cbd39c00de0a696136d8f73f6c9e5a25e404a310` | 树对象完全相同，含生产代码和测试 |
| `integrations/dsh-session-adapter/` | `155457d23f5761c5b025c434de365eed70f1b688` | `155457d23f5761c5b025c434de365eed70f1b688` | 树对象完全相同，含适配器、安装器和测试 |
| `AgentSessionClient.kt` | `3f06b50a1c1f535c2c65fa75152e0ef56edba498` | `3f06b50a1c1f535c2c65fa75152e0ef56edba498` | 客户端协议解析与接口完全相同 |

因此针对上述旧 SHA 执行的 Core 测试与内置适配器测试可作为同一源码的验证证据；本次不为相同代码重复执行测试。测试执行所在 SHA 仍须如实写 `d5b82cb6f796a08838f3a1136b8fbb77e22c0f49`，并附此对象等价证明；不得改写成在新 checkout 重新执行。

## Android 审计链实际变动

- `CoreAgentConversationRepository.kt`：只有两处未命名会话的回退标题由硬编码“新对话”改为空串（897、970附近），行数不变。发送、身份、恢复、队列、取消、历史反查调用链未变。
- `GatewayRuntime.kt`：添加资源 import 和三条资源提示属性；现有中文提示改为读取资源。审计引用的原生能力开关、`authoritativeMessageIds` 与仓储/目录注入结构未变，相关行号整体后移4行。此结论只用于DSH契约链，不宣称对整次Android文案迁移做过全面审核。
- `WorkbenchController.kt`：增加标题解析器 import，并把自动标题占位判断交给 `ConversationTitleResolver`，后段缺失标题回退为空串。审计涉及的原生身份合并、去重及本地占位替换逻辑未变。3388以前引用通常后移1行，3400后本次相关引用后移3行。
- `AgentSessionClient.kt`、`CoreAgentCommandCatalogRepository.kt`、`NativeEventSynchronizer.kt` 没有变动。发送、取消、generation查询、命令能力门禁的结论继续适用。

## 关键源码片段逐行复核

使用 `git show <SHA>:<相对文件>` 提取下列片段，逐行比较旧片段和偏移后的最新片段，全部完全相同：

| 文件 | 原审计行号 | 最新行号 | 结果 |
|---|---|---|---|
| `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/conversations/CoreAgentConversationRepository.kt` | 1266-1337 | 1266-1337 | 逐行完全相同 |
| `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/conversations/CoreAgentConversationRepository.kt` | 1420-1616 | 1420-1616 | 逐行完全相同 |
| `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/conversations/CoreAgentConversationRepository.kt` | 1724-1746 | 1724-1746 | 逐行完全相同 |
| `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/conversations/CoreAgentConversationRepository.kt` | 1812-1845 | 1812-1845 | 逐行完全相同 |
| `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/conversations/CoreAgentConversationRepository.kt` | 1937-1964 | 1937-1964 | 逐行完全相同 |
| `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/GatewayRuntime.kt` | 2650-2680 | 2654-2684 | 逐行完全相同 |
| `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/GatewayRuntime.kt` | 2887-2911 | 2891-2915 | 逐行完全相同 |
| `apps/android/conversation-ui/src/main/kotlin/com/openandroidintelligence/conversation/state/WorkbenchController.kt` | 4870-4905 | 4873-4908 | 逐行完全相同 |
| `apps/android/conversation-ui/src/main/kotlin/com/openandroidintelligence/conversation/state/WorkbenchController.kt` | 5237-5251 | 5240-5254 | 逐行完全相同 |
| `apps/android/conversation-ui/src/main/kotlin/com/openandroidintelligence/conversation/state/WorkbenchController.kt` | 5688-5774 | 5691-5777 | 逐行完全相同 |
| `apps/android/gateway-client/src/main/kotlin/com/openandroidintelligence/gateway/agents/AgentSessionClient.kt` | 161-172 | 161-172 | 逐行完全相同 |
| `apps/android/gateway-client/src/main/kotlin/com/openandroidintelligence/gateway/agents/AgentSessionClient.kt` | 298-440 | 298-440 | 逐行完全相同 |

最新报告应使用下列核心定位：

- `GatewayRuntime.kt:2682`（原2678）：助手原生工作台使用权威消息ID。
- `GatewayRuntime.kt:2915`（原2911）：主工作台原生模式使用权威消息ID。
- `WorkbenchController.kt:4892`（原4889）：只用明确client关联替换本地占位。
- `WorkbenchController.kt:5245`（原5242）：两个不同原生助手消息ID保持独立。
- `WorkbenchController.kt:5705-5708`（原5702-5705）：原生历史不按正文/时间猜测去重。
- `WorkbenchController.kt:5754-5760`（原5751-5757）：优先明确client关联，否则按原生消息ID区分。
- `CoreAgentConversationRepository.kt:1724-1739`、`:1812-1845`、`:1937-1946`：行号不变。
- `AgentSessionClient.kt:161-172`、`:298-440`：行号不变。

## 审计结论影响

`CORE-01`（取消能力与当前Android契约不相容）、`CORE-02`（独立适配器实时身份和历史提交关联不足）、`CORE-03`（DSH缺少活动generation查询，断线/Busy后的队列恢复无法完成）均不受新增提交影响。功能矩阵中归档/删除、附件、命令、工具/审批、eventSync/generationRecovery及Core设备职责的结论同样不变。此处只核对最新源码等价性；没有新增真实宿主/Android设备验证证据。
