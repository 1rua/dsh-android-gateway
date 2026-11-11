# 大会话库列表阻塞健康检查：根因与合成真实宿主证据

日期：2026-11-12，Asia/Shanghai。关联：DSH #10、OAI #148。

## 结论与证据边界

已在全新合成Home、305个自生成v4 Zstandard空会话日志、现有官方DSH CLI中复现：单独认证状态请求约145–155ms成功；唯一会话列表请求启动后，唯一认证状态请求等待5秒超时，未认证请求仍约14ms返回401；列表等待20秒也超时。未加载dsh-context或其他第三方Bundle，未使用模型凭据，模型请求0，未读取生产私人会话正文。

因此这是可复现的适配器查询放大与健康隔离缺陷，不需要先假定私人历史损坏、第三方插件异常、端口未就绪或Token错误。主任务报告的生产认证后超时与此复现相符；本探针没有直接证明生产每一个未完成调用的调用栈，未开启Inspector或改动生产进程。

另经真实宿主API计数证明：1次公开listSessions后，使用并发2的公开observeSession读取305项并释放租约，耗时386.9ms；观察期间未额外调用persistence.list。修复可以复用现行公开API，避免隐藏会话或伪造online。此项是可行性证据，不等同于修复后的业务验收。

## 固定来源

- DSH源码：`acc028af1eb6529aaffd99217d5a797b1c9320bc`。
- OAI内置对应源码：`520eb6696c658d2ca6e36ab489eb76a902f11790`。
- Node `v26.7.0`，Python `3.14.6`，已安装DSH `0.2.2-rc.1`。
- 每份JSON结果包含三个适配器文件SHA256；实际执行快照已与上述来源逐字比对。

## 可定位根因

独立桥 `src/index.js:130` 的summary逐项调用readTitle及readSurface；`src/index.js:431` 对全部records使用Promise.all。内置桥保留相同逻辑。

官方已安装 `@deepseek-ai/dsh-session-query/lib/index.js` 的实际调用链：

- `readTitle(id, signal)`（1109附近）→`readTitleSnapshots([id], signal)`→`SessionCorpus.projectMany`（167附近）→`listPersisted`→`persistence.list`。
- `readSurface(id)`（1168）→`SessionCorpus.load`（128）→`listPersisted`→`persistence.list`。
- `listSessions(signal)`（95）本身也执行一次`persistence.list`。

全冷会话且成功完成一次列表的路径总共执行`1 + 2N`次完整持久层列表；每次又扫描N个会话头。因此是O(N²)元数据查询。N=305时，完整成功路径为611次全库列表，约18.6万个压缩头解码；这是源码推导值，失败探针没有冒称实际已完成全部611轮。

官方 `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` 中：

- `list`（2607）→`listArtifacts`（3110）→`listGenerations`与压缩头读取。
- `listLimit`是该持久层实例共享的`pLimit`，默认并发3（2304、2436）；所有并发列表都共享这个队列。
- `ensureRootEncoding`（3535）是可复用的单次Promise，不是本缺陷无限重复初始化的根因。
- 每轮`listArtifacts`重新读取头，未提供适配器可依赖的全库列表去重缓存。

健康`/status`及`/handshake`同样调用records；它们被后端巨量列表工作拖住。鉴权在records之前，所以401仍迅速返回。适配器没有把HTTP观察断开/超时传给`listSessions`和标题读取，过期查询继续占队列。

Core `agent_health.py` 的现行调度为单Agent去重、5秒超时，探针完成后10秒间隔；源码未发现紧循环。按指定开始时间仅统计Core journal路由/健康转换条数，未找到匹配日志；这不能用于证明生产请求为0或精确请求频率。

## 可复现命令

脚本：[seeded-corpus-status-probe.py](seeded-corpus-status-probe.py)。它仅生成合成原生日志并启动自己的官方DSH进程；退出后只终止自身Popen，不操作正式服务。

```bash
python .worktrees/dsh-remediation-state/seeded-corpus-status-probe.py \
  --adapter .worktrees/dsh-native-reliability/src \
  --output .worktrees/dsh-remediation-state/seeded-corpus-concurrent-results.json \
  --concurrent-health
```

基线结果：[seeded-corpus-status-results.json](seeded-corpus-status-results.json)，3个HTTP观察符合预期，列表20秒超时，结果allPassed=false。

并发结果：[seeded-corpus-concurrent-results.json](seeded-corpus-concurrent-results.json)：

| 观察 | 实际结果 | 耗时 |
| --- | --- | --- |
| 列表前未认证status | 401 | 5.84ms |
| 列表前认证status，第1次 | 200，online=true | 154.95ms |
| 列表前认证status，第2次 | 200，online=true | 145.24ms |
| 列表期间认证status | TimeoutError | 5004.51ms |
| 列表期间未认证status | 401 | 13.67ms |
| 会话列表 | TimeoutError | 20019.65ms |

6个HTTP观察中，4个符合预期、2个超时；这是HTTP观察计数，不是单元测试数量。结果allPassed=false。

## 公开API可行性实证

```bash
python .worktrees/dsh-remediation-state/seeded-corpus-status-probe.py \
  --adapter .worktrees/dsh-native-reliability/src \
  --output .worktrees/dsh-remediation-state/seeded-corpus-observe-results.json \
  --observe-api
```

此模式只在合成宿主加审计插件，给persistence.list计数，不修改生产源码：

- 305条公开listSessions结果。
- 并发2个worker执行observeSession(id, {signal, projectionMode: 'none'})，读取header/events后finally执行租约Symbol.dispose。
- 所有305项成功，386.92445ms。
- 初始列表调用persistence.list 1次；305次观察期间额外list调用0次。
- 结果：[seeded-corpus-observe-results.json](seeded-corpus-observe-results.json)，allPassed=true。

官方observeSession独立走`_observations.read`（347附近）→`persistence.stat(id)`→`findLog(id)`（每project只查询目标ID目录）→`readColdSessionLog/open(id)`，当前v4不会重新读取全部其他会话头。旧格式stat会计算historicalCorpusRevision，open也可能需要迁移前置；应单列旧格式兼容测试，不能把本v4计数结果外推到全部历史格式。

## 修复约束与建议

1. 一次请求只完成一次全库枚举；对每条使用可取消的单会话观察，且并发有界，租约必须释放。
2. 保持title和updatedAt原语义。公开readTitleSnapshots(ids,signal)可批量标题但只返回标题/头；observeSession的raw events可在同一捕获内推导标题和当前surface。官方foldSessionTitle已导出；当前surface对应官方foldSurface(events,currentSessionMessageProjections).nodes，不能用所有raw事件最大时间替代。
3. 官方controller.list虽快，但updatedAt只取lastPromptAt，且过滤无cwd冷会话；直接替换会改变现有行为，应避免。
4. 列表、状态、握手的查询必须有界且可取消；HTTP断开只取消观察，不得取消宿主生成。共享去重查询须正确管理多个观察者，不可因一个观察者离开而中断其他观察者。
5. 不可通过关闭列表能力、隐藏已有会话、无条件复用旧online、吞异常或自动重试掩盖失败。
6. 修复后复跑本305会话并发探针，再补关闭连接释放、同请求去重、长会话正文、旧格式、重命名及updatedAt替换语义回归；最后在生产健康恢复后进入App验收。

## 生产只读边界

本子任务只对生产采集过服务状态、进程CPU/IO/内存/线程等待和文件描述符类别，以及会话文件数量/大小等属性；未读取任何生产会话正文或实际Token值，未向生产追加认证请求。正式DSH随后由主任务停止以释放积压，本子任务已停止该PID采样。
