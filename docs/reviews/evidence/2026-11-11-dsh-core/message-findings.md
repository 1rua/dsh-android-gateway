> 证据归档说明：为避免仓库全局 `*.log` 忽略规则，归档日志使用 `.txt` 后缀；下文原始 `/tmp/` 执行记录中的 `.log` 路径保留其历史含义。

> 归档说明：本分项按最初测试快照记录；最终 OAI dev 已复核至 24172841f9a564c53416f7d066f3450d4feb2bfe，行号修正及源码等价证据见 latest-delta.md，最终结论以主报告为准。

# DSH 消息与可靠性审计分项

审计日期：2026-11-11。独立插件提交 `325a48058dafbfdb0686dc060e08674d8810b4c1`；OAI `dev` 提交 `d5b82cb6f796a08838f3a1136b8fbb77e22c0f49`；本机 DSH `0.2.2-rc.1`。只读生产源码，所有消息正文均为合成文本；未调用真实会话、模型或设备。以下 HTTP 处理器复现使用隔离宿主服务与响应夹具，不能视为真实宿主端到端结果。最后三项直接调用真实安装包的 `SessionController.prototype.prompt` 与 `SessionCommandController`，验证参数、取消原语与 requestId 去重语义，仍不是完整宿主 E2E。

复现命令：`node --test docs/reviews/evidence/2026-11-11-dsh-core/message/repro.mjs`（已使用相对源码入口及自动解析已安装 DSH CLI）。本轮归档前实际执行命令是 `DSH_AUDIT_SOURCE=/mnt/data/projects/dsh-android-gateway/src/index.js node --test /tmp/dsh-audit-20261111/report-stage/evidence/2026-11-11-dsh-core/message/repro.mjs`，结果 **13 通过、0 失败、0 跳过**。日志位于同目录 `repro.log`。通过表示成功复现所述现象，不表示产品正常。

## M-01 / P1 / 已确认且可复现：宿主受理悬挂时观察结束不能释放 Busy 和监听器

- 独立源码：`src/index.js:148-165`，尤其 `154` 在等待 `finishedPromise` 前直接 `await controller.prompt(...)`。
- 内置对照：`integrations/dsh-session-adapter/index.js:270-289,308-318` 已将受理与观察分离，设置独立受理期限，并在观察结束时解除回调。
- 触发：`prompt()` 回执悬挂；随后 HTTP 断连、30 分钟计时器到期，或者宿主真实完成事件先于回执到达。
- 复现：13 个测试中第 4/5/6 项。断连后 `signal.aborted=true`，但处理器仍未结束、2 个宿主监听器保留，再发同会话得到 `409 SESSION_BUSY`；超时时虽写出 `AGENT_TIMEOUT` 帧，但响应不结束、Busy 不释放；完成事件先到时虽写出 `done`，仍等待回执。超时测试只把对应 30 分钟系统定时器压到 15ms，没有改生产源码。
- 实际/预期：观察信号可以解析 `finishedPromise`，却无法打断更前面的受理等待；预期应按观察期限结束连接并释放本地资源，同时保留宿主任务结果未知这一事实。
- 根因：一次宿主受理 Promise 持有全部观察闭包，`finally` 只在其返回后执行。
- 影响：单会话长期甚至永久 Busy、每次挂起保留监听器/响应对象；宿主侧完成也不能彻底清理。
- 建议：参照内置的可解除受理回调、独立受理/观察预算；未确定宿主未受理时返回 `OUTCOME_UNKNOWN`，不要把 `AGENT_TIMEOUT` 等同于执行失败。
- 验证：挂起受理 + 断连/超时/先完成三组测试均要求监听器归零、Busy 可释放，晚到受理与拒绝被消费且不影响新观察。

## M-02 / P1 / 已确认且可复现：取消不核对 generationId，可能取消当前其他轮次

- 独立源码：`src/index.js:81,233-246`，尤其 `243` 只传 `{sessionId}`。
- Core 契约：`oai-core/src/oai_core/sessions.py:1234-1242` 接收 `generationId`；`adapters/remote.py:550-565` 转成 `{value:{generationId}}`。
- 实际宿主：安装包 `@deepseek-ai/dsh-api-session-controller/lib/index.js:960-969`（未打包可读对应 `lib/types/commands.js:448-457`）只执行目标会话当前 `agent.cancel(...,{keepInbox:true})`，不存在轮次比较。
- 内置对照：`integrations/dsh-session-adapter/index.js:133-136` 明确关闭 `cancel`，防止误打其他轮次。
- 触发/复现：旧轮次 A 已完成、会话开始 B；提交 `{value:{generationId:'old-generation'}}`，插件 `200`，宿主收到 `{sessionId:'one'}`，完全丢失 A 的目标约束；该宿主原语会取消当前 B；第 11 个测试直接调用真实安装包取消方法，确认任意旧 generationId 都只调用当前 Agent 的 `cancel`。
- 影响：App 延迟取消或重试取消可中断终端/App 刚开始的新任务；不能据 `200` 判断取消了指定任务。
- 建议：只有宿主提供原子轮次匹配取消时才声明支持；在此之前关闭能力并返回不支持。仅在插件内先查询后取消仍有竞态，不能根治。
- 验证：A/B 轮次竞争、旧目标取消、空目标取消和并发新轮次均不得对非目标任务产生副作用。

## M-03 / P1 / 已确认桥接缺失，可复现：客户端消息与原生消息身份链断裂

- 独立源码：`src/index.js:112,132,134-137,219-224,229-230`。每次随机原生 `requestId`，请求只允许 `text`，终态只输出 `type/text`，历史只输出 `id/role/text/createdAt`。
- 当前 Core：`adapters/remote.py:233-235,373-374` 仅在桥声明 `clientMessageIdentity` 后传 `clientMessageId`，因此正常配置下不会盲目给独立插件新增字段；不能写成“所有当前 Core 发送必然 400”。直接携带 ID 会 `400`；普通 Core 发送则丢失这条关联。
- 内置对照：`integrations/dsh-session-adapter/index.js:131,167-172,214-220,225-236,397-399` 支持稳定客户端 ID 并返回真实 `userMessageId/messageId`。内置历史 `387-392` 同样不输出 `clientMessageId`，此子项属共同缺口。
- 复现：相同文本两次提交产生两个不同原生 `requestId`；含 `clientMessageId` 请求在宿主调用前 `400 SCHEMA_INVALID`；已给原生事件 `id:'native-user'/'native-assistant'`，流终态仍无两种 ID；历史保留原生 ID 但丢弃 `source.rpcId`。
- 实际宿主事实：本机 DSH 0.2.2-rc.1 的 `lib/index.js:831-833,1011-1020` 已实现基于 `requestId` 检查 inbox/历史的去重。不能照搬内置旧注释认定宿主完全没有去重；第 12 个测试直接调用真实安装包方法确认同 rpcId 在 inbox 中提前返回 accepted；独立插件的随机 ID 使其无法利用该去重。
- 影响：Core 操作 ID 可在 Core 本身的保留窗口防止同操作重做，但不能在 Core 丢状态/更换操作 ID 或桥路由层重试时恢复同一原生请求身份；App 无法从流/历史把本地临时行与原生行可靠关联。具体 Android 后果请结合客户端分项证据。
- 建议：传递并保留稳定客户端 ID、只在取得真实原生 ID 后回传它；不要伪造 generationRecovery/idempotentSend。宿主去重需单独验证冷热会话、并发重复请求与重启持久性。
- 验证：同 ID 重试、同正文不同 ID、Core 回执丢失、冷会话恢复；要求原生执行次数、返回 ID 和历史关联可验证。

## M-04 / P2 / 已确认且可复现：慢观察者没有背压或缓冲上限

- 独立源码：`src/index.js:118-120,140-145`，忽略 `res.write` 的布尔返回值，直接在宿主事件同步回调中写。
- 内置对照：`integrations/dsh-session-adapter/index.js:13-15,174-200,256-266,303-305`，限制 128 帧/1MiB，等待 drain 并设置 drain 期限，仅切断观察。
- 复现：响应第一次 `write()` 即返回 `false`（Node 已无法立即消费），仍继续接收全部 2000 个 1KiB 合成 delta，未等待 drain、未断开慢观察；合成待写量约 2MiB。这是受控背压夹具证据，没有实际耗尽内存。
- 影响：DSH 事件生产速率高于 Core/网络消费速率时，Node 响应写缓冲可以持续增长；多个慢连接会扩大进程内存压力。属于已确认无界写入路径，未宣称本轮发生 OOM。
- 建议：有界观察队列、写入 drain 处理与期限；溢出只结束观察，不取消宿主任务。
- 验证：2000 帧突发、多会话慢/快观察并行、drain 恢复/永不恢复、终态前断连；检查队列字节/帧上限和监听器释放。

## M-05 / P2 / 已确认且可复现：长会话使会话列表整体失败（两版共同缺陷）

- 独立源码：`src/index.js:95-100,198`；内置 `integrations/dsh-session-adapter/index.js:150-155,363`。
- 触发：任意一条会话 `readSurface().events` 超过 JS 调用参数数量限制。摘要用 `Math.max(createdAt,titleTime,...events.map(...))` 把每条事件作为一个函数参数。
- 复现：单会话 150000 个合成 `{time:1000}` 事件，`GET /sessions` 变成 `503 {code:'AGENT_UNAVAILABLE'}`；事件数组本身合法。Node 此处 `Math.max(...150000项)` 触发 `RangeError`，被外层统一错误映射掩盖。
- 影响：一个很长的持久会话使整个列表不可用，阻断其他正常会话发现；历史未分页及全量读取还会放大开销，但本轮确定缺陷是参数展开崩溃。
- 建议：通过迭代计算最大时间；结合实际 query 摘要/投影接口避免每次列表全量重读所有历史。此项不能以同步到内置就算解决。
- 验证：15 万及更大事件摘要、混合正常/长会话列表，不得丢其他会话；检查峰值内存和返回耗时。

## 需要明确保留的反例与未证实事项

1. **不能声称“断观察就取消已受理 DSH 任务”。** 本机真实 `SessionController.prototype.prompt`（`lib/index.js:4048-4060`）只在入口 `signal.throwIfAborted()`，随后不把 signal 传给 `commands.prompt`。直接调用真实方法验证：入口后 abort 仍 `accepted:true`，入口前已 abort 才拒绝。独立代码确实把观察 signal 传入，但当前本机宿主不监听受理后取消。
2. **内置版本存在不同方向的宿主 API 漂移风险，需单独确认。** 内置 `index.js:287-289` 不传 signal，而本机真实 `SessionController.prototype.prompt(request)` 无条件读 `signal.throwIfAborted()`，直接调用抛 `TypeError`。这已是实际方法契约测试，但尚需真实 Cordis 注入路径验证是否存在包装器；主 Agent 正做真实宿主探测。不能把独立传 signal 简单判作回归修复目标。
3. 未复现原生 `turn/start -> user/message -> assistant-stream -> turn/end` 顺序错配。实际本机 `dsh-agent-loop/lib/index.js:723-765,862-866` 在 turn/start 后写 user/message，与插件相关性逻辑符合。
4. 插件没有 generationRecovery 与桥级幂等声明，不应把未声明能力称为虚假支持。Core/Android 应根据能力走保守未知结果路径，完整恢复仍属明确缺口。

## 新增并发通过证据

第 13 项验证独立插件双会话并发，各自 turn 7/19、故意共用 attemptId，delta/终态未串流；错误 turn 999 未使会话结束；监听器完成一会话时 4→2、全部完成时 2→0。属于隔离事件与服务夹具证据，不冒充真实双会话模型 E2E。
