# DSH 大会话查询修复独立双轴审查

审查日期：2026-11-12，Asia/Shanghai。结论：当前指定工作树快照未发现可复现的新 P1/P2 缺陷；Standards 与 Spec 两轴均无阻断项。此结论仅覆盖下面固定的源码快照、聚焦回归和合成竞态探针，不替代正式服务部署、真实 HMAC 与模拟器验收。

## 固定范围与独立性

| 仓库 | 固定基准 | 实际 HEAD | 工作树入口 SHA256 |
| --- | --- | --- | --- |
| OAI | `688e2b8197f67bbdcf9da00e8fb4948060466869` | `4bf09d5c98427eda5c3303d9722894d3fd32b08d` | `f93aae1d8bc3cf603944e71c56f9f8e1e27759be7ca4fec4f6ef2d35b6d7e393` |
| 独立 DSH 插件 | `a91a8c93b5787d6415c4960993cc16f913c5a963` | `1735cd4960024e97d0ad8305d702aeaf58275ed1` | `b5ed48fae300da3acfc2f5d651b286577af67724a9ec10580ed9959b87022c56` |

审查开始与结束均核对状态和指纹，没有修改两侧源文件。基准到 HEAD 都仅有修复计划提交；功能实现尚未提交，因此实际审查命令为 `git diff <固定基准> -- <路径>`，并额外完整读取未跟踪的 `corpus.test.js`，没有以三点提交差异代替未提交实现。OAI 审查范围为 `integrations/dsh-session-adapter/index.js`、`host-contract.test.js`、`corpus.test.js` 及计划；独立插件对应 `src/index.js`、`test/host-contract.test.js`、`test/corpus.test.js`、`tools/verify-upstream-drift.mjs` 及计划。

已应用 `.agents/skills/code-review/SKILL.md`。本审查由独立于开发上下文的子 Agent 执行；当时四个并发槽均占满，按主任务明确授权在同一审查上下文顺序完成两轴，没有另启两个审查子 Agent。`docs/agents/issue-tracker.md` 不存在；技能建议通过 `/setup-matt-pocock-skills` 补齐，但本任务已明确提供 issue，故通过只读 `gh issue view` 取得 OAI #148、DSH #10 的正文作为 Spec，继续审查。

标准来源：两仓 `AGENTS.md`、当前会话提供的中文/相对路径/保留数据/轻量测试要求，以及技能的十二项代码气味基线。已查 Context7 的官方 DeepSeek Harness 条目；具体契约结论以本机实际安装的 `0.2.2-rc.1` 发行源码为准，未把 master 文档描述当成已安装版本实现。

## Standards

确认缺陷：0。未发现本次改动新增的绝对路径、凭据、构建产物、空实现、伪在线状态或无关 UI 行为。目录读取、摘要投影和取消保护属于同一职责，没有足以单独提出的代码气味问题。

两仓 `git diff --check <固定基准>` 均通过。独立插件的漂移检查已把新增 `corpus.test.js` 纳入逐字归一化比较，实际十组全部通过，既有认证/部署入口差异保持原有核对边界。新增源码注释与测试描述为中文。

租约释放由 `try/finally` 负责，读取名额也在独立的 `finally` 中转交或归还；未使用后台丢弃任务、吞异常或自动重试代替实际清理。未对两仓实现或测试进行开发性修改。

## Spec

确认缺陷：0。issue 要求“保持所有原生会话、真实标题、真实更新时间……不加任意列表上限”：新路径保留完整枚举结果及原顺序，用官方精确观察和未发布的会话投影形成摘要；末条标题事件与官方 `foldSessionTitle` 的两个被使用字段一致，更新时间仍只取创建时间、标题时间及当前 surface 时间。替换前已失效输入的较大时间、非 surface 的轮次结束时间没有混入排序。

issue 要求“有界并发、观察断开/期限释放……失败真实返回”：共享两个摘要读取名额，多个请求使用同一队列；请求断开、期限和首个摘要失败均向未完成观察传递取消。已取得的租约在投影成功、投影失败、取消与迟到返回时均释放，原始错误保留。状态和握手仍查询真实宿主，没有使用陈旧在线缓存；新取消只属于查询观察，没有接入宿主生成取消。

旧宿主仍调用原有 `readTitle` / `readSurface`，现有能力声明、原生会话 ID、归档语义和返回结构没有因新路径改变。正式部署、真实 HMAC 与模拟器发现仍属于 issue 的后续验收，不能由本报告宣告整项需求闭环。

## 关键实现与契约核对

以下行号首先引用 OAI 工作树；独立插件对应实现整体提前 38 行，漂移检查已确认语义相同。

| 核对事项 | 实现与官方契约 | 独立观察 |
| --- | --- | --- |
| 标题与当前表面 | `index.js:215` 至 `245`；官方 `dsh-session-title/lib/index.js:188` 的 `foldSessionTitle`、`dsh-session-query/lib/index.js:854` 的当前表面和 `1168` 的 `readSurface` | 两个真实宿主投影测试逐字段比较原生读法：替换消息场景最终时间为 4000，继承日志场景为 8000；原日志、原会话表不变。 |
| 继承日志与副作用 | `index.js:226` 使用随机的未发布会话 ID，保留 `inheritedEventCount`；官方 `dsh-session/lib/index.js:1808` 的 `prepare` 不进入会话表，未调用 `enter` 或 `announce` | 已检查 `host-contract.test.js:168`；读取不向原会话追加种子事件，不抢占原生 ID，不触发模型调用。 |
| 观察租约 | `index.js:221`、`232` 至 `235`；官方 `dsh-session-query/lib/index.js:449` 的租约由 `Symbol.dispose` 减少引用，活跃会话观察在 `477` 附近捕获固定 seq | 聚焦回归覆盖投影失败与同批观察失败；独立探针额外覆盖断开/超时后宿主才返回租约的情况。 |
| 共享并发与取消队列 | `index.js:171` 至 `195` 与 `247` 至 `269` | 两桥各 18 个请求交错取消后，挂起观察上限始终 2，剩余 6 个列表完整成功，后续列表仍成功；全部已取得租约释放。 |
| 查询生命周期 | `index.js:151` 至 `169`、`559` 至 `590` | 超时返回 `504/AGENT_QUERY_TIMEOUT`；已断开请求不启动读取；监听移除；迟到租约继续通过清理路径释放，没有未处理拒绝。 |
| 安全边界 | 本次 diff 未更改令牌比较、HMAC payload/proof、只监听回环地址、会话作用域、生成取消和设备授权边界 | 本审查所有实际请求都在进程内，使用合成令牌；没有加载生产配置、读取私人正文、调用真实模型、操作服务或设备。 |

## 本次实际执行

1. 从 OAI 工作树运行 `node ../../node_modules/vitest/vitest.mjs run integrations/dsh-session-adapter/corpus.test.js integrations/dsh-session-adapter/host-contract.test.js`：2 个文件、13 项通过，真实宿主契约未跳过。运行器为根目录 Vitest `4.1.10`，Node `v26.7.0`。
2. 从独立插件工作树运行 `OAI_UPSTREAM_ROOT=../dsh-corpus-scaling node tools/verify-upstream-drift.mjs`：10 组全部一致，包含未跟踪的新目录回归。
3. 两仓分别执行 `git diff --check <固定基准>`：通过。
4. 运行 [独立竞态探针](corpus-final-independent-probe.mjs)：两桥共 6 项通过；见 [结果](corpus-final-independent-probe-results.json)。断开后迟到租约、18 请求交错取消及超时后迟到租约均无泄漏；每桥最终累计取得 44 个租约并释放 44 个，`unhandled` 为空。

没有重跑 133/90 全套 Node 测试、Full、编译、远端 CI 或 305 会话服务探针。主任务提供的 [资源结果](corpus-resource-results.json) 入口指纹与本次 OAI 快照一致，其中 305 会话、一次持久层枚举、305 次观察释放和无持久副作用属于已有受控宿主证据；本报告仅把它作为额外线索，没有计入本审查独立执行次数。[根因报告](corpus-scaling-root-cause.md) 所指全库放大调用链已重新对照安装源码核验。

## 保留边界

- 当前官方精确观察路径可取消；旧宿主回退的 `readSurface(id)` 本身没有信号参数。本次实现能停止后续摘要，但不能强制中断一个旧宿主已经开始且不响应取消的读取，读取名额须等其结束后释放。回退保留已有能力，不能表述为“所有旧宿主都获得同等取消能力”。
- 共享上限约束摘要观察，不对每个请求开头的一次目录枚举做跨请求合并；没有证据表明这是当前 issue 的新缺陷，也不能据此声称任意并发请求数量下健康响应都受同一个上限保护。
- 13 项聚焦测试中的真实宿主层真实执行 `SessionStore.prepare`、`readSurface`、`foldSessionTitle`，观察对象由测试替身提供；6 项独立竞态探针同样属于进程内合成语义证据。它们不能替代真实官方服务端的全链资源证据。
- 305 个空正文 v4 压缩会话的已有结果不覆盖超大正文、所有历史日志格式或任意第三方投影插件；本次没有读取私人正文验证这些边界。
- 需要主任务完成正式服务保留账号/密钥/历史的部署、真实 HMAC 和模拟器发现，并将正式审查/验收报告按项目要求归档到文档目录后，才能关闭部署验收要求。

双轴计数：Standards 0 项，未发现该轴阻断缺陷；Spec 0 项，未发现该轴阻断缺陷。上述部署与兼容范围作为明确保留边界，不冒充已完成验证。
