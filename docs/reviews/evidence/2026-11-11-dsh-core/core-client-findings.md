> 证据归档说明：为避免仓库全局 `*.log` 忽略规则，归档日志使用 `.txt` 后缀；下文原始 `/tmp/` 执行记录中的 `.log` 路径保留其历史含义。

> 归档说明：本分项按最初测试快照记录；最终 OAI dev 已复核至 24172841f9a564c53416f7d066f3450d4feb2bfe，行号修正及源码等价证据见 latest-delta.md，最终结论以主报告为准。

# Core 与 Android 客户端覆盖审查

审查基准：独立插件 `325a48058dafbfdb0686dc060e08674d8810b4c1`；OAI `dev` `d5b82cb6f796a08838f3a1136b8fbb77e22c0f49`。本文件全部结论来自当前源码与本轮测试，不采用历史报告作为通过证据。下文 `OAI/` 是 OAI 仓库根目录，`DSH/` 是独立仓库根目录。

## 已确认的跨层契约问题

### CORE-01 / P1：取消能力声明与当前 Core/Android 取消协议不相容，过期取消还可能取消新轮次

- 独立插件 `DSH/src/index.js:81`（能力函数）在宿主暴露 `cancel` 时声明 `cancel:true`；`242-246` 执行 `controller.cancel({sessionId:id})`，忽略请求 `value.generationId` 并返回 `{id,action}`。
- Core `OAI/oai-core/src/oai_core/sessions.py:1234-1242` 接收客户端 `generationId`，`adapters/remote.py:551-565` 把它作为 `{value:{generationId}}` 传桥；`sessions.py:1204-1211` 仅把桥回执包为 `{session:...}`。
- 当前 Android `OAI/apps/android/gateway-client/src/main/kotlin/com/openandroidintelligence/gateway/agents/AgentSessionClient.kt:161-172` 要求回执同 `generationId` 且 outcome 为 `cancelled/already_completed`。独立插件的 200 不满足此条件，客户端必得到 `OUTCOME_UNKNOWN`。
- `CoreAgentConversationRepository.kt:1812-1827` 还要求宿主 generation 路由与 ID；插件流完全没有 generation 帧，正常 Android 路径无法获得可取消的宿主轮次，因此“cancel:true”不代表 Android 停止可用。
- 复现：用旧 generation 调用 `/cancel`；消息 Agent 已隔离复现桥仅把 sessionId 交宿主（其 `/tmp/dsh-audit-20261111/message/repro.mjs`）。在当前新一轮仍运行时这会取消新轮次，而回执又无法证明取消目标。
- 预期：只能原子比较并取消目标 generation；暂不具备宿主契约时声明 false。
- 内置对照：`integrations/dsh-session-adapter/index.js:133-136` 已明确 `cancel=false`，并解释宿主 session-only cancel 无法安全比较目标。这是安全修复，独立版本尚未同步。
- 修复建议：先回退能力 false；若后续宿主新增精确 turn compare-and-cancel，建立 generation 与 rpcId 的稳定映射，再提供明确终态回执。
- 验证：过期 generation 不得影响新轮次；同轮重复取消须稳定返回 cancelled/already_completed；当前 Android 可读取同一 generation 的回执。

### CORE-02 / P2：独立插件丢失实时消息身份，历史也无法关联客户端提交

- `DSH/src/index.js:110-118` 为每次提交生成随机 requestId；`turnResult:16-19` 只返回 done.text/error.code；`history:219-223` 保留原生 id 但丢弃 `message.source.rpcId`，亦未提供 clientMessageId。
- Core `remote.py:232-235,373-374` 仅在 `clientMessageIdentity=true` 时转发客户端 ID；独立版本未声明该能力，故当前 Core 正确降级只发 text。这说明不是“Core 总会发多余字段导致独立400”。
- Android `GatewayRuntime.kt:2910-2911` 对原生历史使用权威原生消息 ID；`CoreAgentConversationRepository.kt:1334-1337` 在尚无原生 ID 时先用 client ID 和 `stream_<clientId>` 占位，`1420-1446` 只有明确 MessageIdentity 才能转换成原生 ID。
- 源码后果：随后刷新历史时，两侧 ID 无法关联；`CoreAgentConversationRepository.kt:1937-1946` 按 clientMessageId 查已发送消息，独立历史永远无匹配。WorkbenchController.kt:5702-5705、5751-5757 明确禁止按相同正文/相邻时间合并原生消息。因此不能依靠正文去重补偿该缺口。
- 已复现证据：消息 Agent 的探针确认 done 不含 messageId/userMessageId、history 丢 rpcId。Android 界面重复展示属于源码推导，未跑 APK/真机复现，不应写成已验证真机现象。
- 内置对照：`integrations/dsh-session-adapter/index.js:131,172,214-229,236` 转发 client ID 并在终态附 userMessageId/messageId，能解决当前在线提交的原生 ID 关联；但其 `history:387-391` 同样未导出 source.rpcId，所以重启后 client ID 反查与 generationRecovery 仍不支持。
- 修复建议：同步内置稳定身份与终态消息 ID；对历史导出可验证的 rpcId/clientMessageId 关联。不要按文本猜测身份，也不要将此项等同于宿主幂等。
- 验证：重复相同文字两次，实时和历史准确保持两条；单次实时+刷新仍只有一组原生消息；断线后可按原 client ID 找到既有输入，且不重发。

### CORE-03 / P2：断线/Busy 后队列恢复依赖 DSH 两版均未实现的活动生成查询

- 独立/内置均无 `/sessions/:id/generation`；生成恢复能力未声明或明确 false。
- Core `remote.py:292-301` 的 current_generation 直接访问该路由；`sessions.py:874-879` 对无查询参数的活动生成仅检查 send 能力，而不是 generationRecovery，因而 send=true 时仍会转发。
- Android `CoreAgentConversationRepository.kt:1724-1739` 的 retryPendingDeliveriesFor 在存在队列且当前无本地轮次时，无条件查询 currentGeneration；404 会设置 queueUnknownBarriers 并直接返回，不会投递队列。`NativeNotificationReconciler` 等也不能从无路由状态推定“宿主已空闲”。
- 本轮隔离真实插件+当前 Python adapter 探针：online=true, send=true, current_generation→404 NOT_FOUND，1 passed。宿主为合成只读 sessionQuery，未调用真实 DSH 生成，不是实际宿主端到端验证。
- 分类：共享恢复功能缺失及客户端兼容风险；不能说独立版本特有。正常同一连接结束后 drainQueuedSends 不查询此路由，可正常排空；问题是断线/Busy/重新接入后的显式恢复路径。
- 建议：先制定独立的只读 current-generation 契约与能力门禁；宿主能够提供权威活动 turn 时实现，不能用空值冒充 idle。客户端在未支持活动状态时保留明确未知状态并给出可解释结果，不做无条件重发。
- 验证：先排队后断线/重新接入，真实原轮次运行中不得投递；确认原轮次结束后按同一队列身份各投递一次；不应以吞404替代状态证据。

## 功能覆盖矩阵

状态用语：`验证通过`只限定对应测试证据层级；本 Agent 未执行真实 DSH 生成或 Android APK。本表的“已实现但未验证”指尚未获本轮真实宿主全链路证据，可由主 Agent 的宿主测试提升限定状态。

| 功能 | 独立插件实际实现 | OAI 内置适配器 | Core 实际接口/职责 | Android 可用性与本轮验证状态 |
|---|---|---|---|---|
| Agent 发现/在线能力 | status+handshake；运行时 query/函数检查 | 同类实现，另心跳、身份、恢复降级字段 | registry discovery/health；认证注册由 Core 管理 | 支持 CoreAgent descriptors；本轮 Core 测试通过，真实宿主由主 Agent 验证 |
| 原生会话列表/终端新增发现 | 每次 listSessions，新列表非静态缓存 | 同 | GET agents/:id/sessions | 支持列表刷新；已实现但真实终端双向发现未验证 |
| App 创建会话 | controller.create，随后 requireSession/read summary | 同 | POST sessions，Core operation ledger 限定请求幂等 | 支持创建及请求回执恢复；已实现但终端可见性需实际宿主验证 |
| 历史文字、顺序、稳定原生ID | readSurface 过滤 user/assistant，保留输入顺序和 message.id | 同 | GET history 原样代理 | 支持权威 ID；历史 rpcId/client 关联缺失，详 CORE-02 |
| 重命名 | controller.rename | 同 | PATCH action=rename | 以 rename 能力展示；已实现但真实宿主未验证 |
| 原生归档/取消归档 | capability false；死分支不能算实现 | 同 false | Core 有路由，能力门禁405 | Android 按能力禁用；明确不支持，不是“错误声明支持” |
| 原生删除 | capability false；没有实际 delete 调用 | 同 false | Core DELETE + capability gate | Android 禁用；明确不支持 |
| 文字发送 | prompt(mode=queue) + session rpcId 关联 | 同，新增 clientId 入参/终态原生ID/受理观察预算 | Core POST messages/SSE、独立生产者、操作ledger | 正常文字链已实现；独立身份与可靠性存在Bug，不能标整体通过 |
| 图片/文件输入 | 不声明 attachments，不存在上传路由，只接受 text | 同 | Core有附件属主校验、上传桥能力门禁 | Android发送前 capability 检查，返回UNSUPPORTED_CAPABILITY；明确不支持 |
| 历史附件回读 | textOf 仅拼 text，history 不含 attachments | 同 | Core支持 metadata/附件流与属主绑定；需桥提供附件引用 | DSH图/文件历史内容在App缺失；桥功能缺失，不能要求桥重复管理设备权限 |
| 文本流增量 | agent/assistant-stream text-delta | 同；内置有心跳和有界观察队列 | NDJSON解析/SSE转换，8MiB帧限制 | Android支持delta/done/error；已实现但可靠性存在Bug |
| 完成/失败终态 | turnResult 映射多种 reason | 同，增加原生消息身份和unknown语义 | Core转发终态并记操作回执 | 支持，独立done身份不足；宿主真实终态仍需实测 |
| 停止/精确取消 | 错误声明cancel true；仅session级cancel | false安全降级 | Core接收目标 generationId，桥须精确执行并回执 | 独立已实现但有Bug/当前App不完整，详CORE-01；内置明确不支持 |
| 断线观察/重连 | 只有一次性流；无generation/events查询 | 有心跳/隔离观察者，无持久恢复查询 | Core可保留生产者，不能代造宿主generation事实 | Android有generationRecovery/eventSync路径，但DSH均不提供；明确不支持可靠恢复，详CORE-03 |
| 重新发送/幂等 | 每次新随机rpcId，无持久去重 | 可转clientId但明确idempotentSend=false | Core操作ledger可拦同请求ID，不等同宿主 exactly-once | 禁止将正常200或相同clientId认作无重复执行；未知结果恢复缺失 |
| 多次发送/队列 | 本观察者busy Set；实际宿主mode=queue | 同，观察者释放更可靠 | Core并发生产者隔离；宿主拥有native inbox | Android有本地Queue；普通完成可drain，断线恢复有CORE-03缺口 |
| /new | 无命令目录/原生命令解析路由 | 同 | Core有原生create接口，不能混同文字命令 | App“新建会话”走create；DSH `/new`命令未桥接，明确不支持命令形式 |
| 模型切换/DSH原生命令 | commands=false/无命令API，输入统一作为prompt文字 | 同 | Core命令catalog路由仅能力true启用 | Android命令目录按capability；明确不支持通过桥切模型/执行原生命令，不能把`/model`文本投递算执行成功 |
| 工具调用/工具结果可视化 | 只保留文字助手消息/文本增量，不映射工具事件 | 同 | Core/Android支持executionSteps/generation结构 | Agent宿主可执行工具≠App能看到；桥功能缺失 |
| DSH审批请求/决策 | approvals=false，无路由，无事件映射 | 同 | Core /approvals/:id/decisions 与卡片校验 | Android支持卡片但DSH能力关闭；明确不支持宿主审批交互，需要终端介入，不能伪造放行 |
| 终端/App双向历史刷新 | list/history主动拉取，非事件同步 | 同 | Core events/ack需eventSync能力 | 手动/生命周期刷新已实现；持续事件同步明确不支持 |
| Android设备CLI/MCP/API | 插件不处理设备授权或设备请求 | 同 | `device_service.py:19-48,76+`、`cli.py:55-68,434-445`、`mcp.py:59-96` | 应由Core负责，不属于会话桥职责；需要独立Core登录/配对/Android授权，真实调用本Agent未验证 |
| 安装/更新/卸载/诊断/多Profile | 独立Bundle；安装Agent另审 | 内置安装器/diagnostics | Core dsh_installation/management | 属Core安装管理+宿主Bundle管理，非Android重复实现；本表不替安装Agent结论 |

## 相关职责边界

- `OAI/oai-core/src/oai_core/adapters/dsh.py:1-5,16-25` 明确 DSH 为 deployment 共享 corpus，无 OAI account ID 发入 DSH；两个已认证 Core 用户看见同一部署会话是现行契约。若部署预期用户互不信任，应拆 DSH 实例/注册范围；不能将现行共享语义直接判为越权。
- `remote.py:79-82,150-155` 限制远端非loopback必须HTTPS、桥token至少32字符；Core到桥发桥Bearer，设备凭据不透传。`test_dsh.py:12-47` 本轮验证共享发现和不转发 Core 设备身份头；诊断 trace header 是另外的可选追踪，不是账号授权凭据。
- Core `sessions.py:1005-1139` 将生产者与Android SSE观察者分开，观察者断开或队列溢出不取消宿主；插件自己的close/abort行为不能用Core这一保护代替验证。
- Core operationRecovery 对操作请求的去重/回执有效，但 generationRecovery 是宿主执行事实，不能用前者宣称后者实现。

## 本轮测试证据

环境：`python` 默认可导入 pytest `9.1.1`、aiohttp `3.14.5`；未新建依赖环境，未读取真实账号配置。OAI工作目录为固定 dev SHA。测试均用合成账号、临时数据库与隔离HTTP服务器。

命令：

```bash
PYTHONPATH=oai-core/src python -m pytest \
  oai-core/tests/test_dsh.py \
  oai-core/tests/test_remote_stream_frames.py \
  oai-core/tests/test_remote_stream_phases.py \
  oai-core/tests/test_remote_generation.py \
  oai-core/tests/test_native_interactions_core.py \
  oai-core/tests/test_native_operation_recovery.py \
  -q -p no:cacheprovider
```

结果：`89 passed in 1.71s`，0失败、0跳过。日志 `/tmp/dsh-audit-20261111/core/pytest-core.log`。这些覆盖 Core transport/frame/phase/generation/interaction/operation recovery 的既有实现，服务端为测试夹具，不能据此宣布独立插件真实生成恢复已通过。

额外命令：

```bash
PYTHONPATH=oai-core/src python /tmp/dsh-audit-20261111/core/generation-route-probe.py
```

结果：`1 passed`；关键输出：`{"online": true, "send": true, "currentGeneration": "NOT_FOUND", "httpStatus": 404}`。Node真实加载未修改的独立插件HTTP handler、Python真实使用未修改 DshSessionAdapter；sessionQuery是合成数据。文件为 `core/generation-route-probe.mjs`、`.py`、`.log`。这仅确认路由契约缺口，未执行任何真实 DSH 生成、Android动作或持久私有数据操作。

Android：本轮执行源码调用链审查；未运行Gradle/模拟器/物理设备，不将静态推导升级为客户端实测。
