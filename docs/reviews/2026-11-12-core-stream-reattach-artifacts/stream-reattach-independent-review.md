# Core 原生流多观察重附独立双轴审查

日期：2026-11-12，Asia/Shanghai。最终结论：**Standards 0 项未解决问题，Spec 0 项未解决问题**。首轮独立审查确认两项并发时序缺陷，已反馈开发、同步修复两仓并在最终固定提交上独立复验通过。可以继续主任务的真实模型和部署/模拟器验收；本报告不将零模型受控验证视作完整 E2E 完成。

## 固定来源与范围

| 仓库 / PR | 基准 | 最终审查头 | index.js SHA256 |
| --- | --- | --- | --- |
| OAI #154 | `eecbb06fbe591591bc367e08b8fd0f98b0e7e23d` | `cf57e834897798fa0b58c40c3bb1781c867b02e3` | `54bec1dd68ae8fd5f0beeea064d05a5fc16a80e6e40cf5e9373d03aaa2153caa` |
| 独立 DSH #13 | `c44511547ecc12e53717ab290a49cf35adc88c22` | `93222dc3dba25d8bce87fe67f5dda134f0b2f2f2` | `4feb77fbd23ff9a00a65cfffe8ade90acf67fa0727454382a6797adb7863cebe` |

真实工作树经 `git worktree list --porcelain` 核对，为 `../dsh-stream-reattach` 与 `../dsh-plugin-stream-reattach`。最终本地与只读 GitHub PR 元数据一致，两仓均干净；两 PR 仍为 Draft / OPEN。比较方向分别为 `git diff <上表基准>...<上表最终头>`，包含实际实现、14 项重附回归、既有断言调整、计划、脱敏验收证据和双仓漂移清单。

独立插件运行反馈环时固定为 `25a988e807f7854b313285d632c0d312cc749aa1`，index 指纹为 `0c14bfc648843bff7df690cbe85e6eca49ad549a0c202c25acb086e203417de9`。随后 `93222dc3` 只恢复 3 处源码中文注释及 1 处测试中文注释，已逐处对照，无可执行逻辑变化；最终重新核对清洁状态、11 对漂移及 6 项独立探针通过，未重复运行无需重跑的完整套件。

Spec 来自只读获取的 OAI Issue #152、DSH Issue #12 正文；先阅读 [根因记录](core-http-busy-root-cause.md)，再独立核对桥实现与 Core `sessions.py` 的 producer / HTTP 观察分离。标准来源为当前会话与仓库 `AGENTS.md`，以及已读 `code-review` Skill 的 Standards / Spec 双轴与十二项气味基线。四槽并发限制下按主任务授权顺序完成两个轴；审查者未参与修复实现，只提供可复现问题及独立复验，没有修改两仓源码、服务、设备、远端或提交。

## Standards

最终未解决问题：0。

实现将提交声明与观察连接分开，复用原生 generation 投影和既有有界帧队列、背压与观察期限；没有增加自动重发、取消宿主或伪造终态。共享记录保存会话/客户端标量、受理事实与可解绑回调集合，观察结束即移除自己的回调和监听器；没有在共享记录中保存正文和响应对象。`releaseSubmission` 先比较记录对象身份，再在无观察且事实允许时释放，旧轮次迟到回执不能删除新声明。

新增注释与测试描述为中文，跨仓漂移已纳入新重附测试。对归档结果末尾空行，首轮 `git diff --check` 检出四个文件，已告知主任务并由开发清理；这是工具可直接检查的格式问题，不计为独立代码审查发现。最终两仓 `git diff --check` 均通过，11 对漂移核验均通过。未发现足以单独提出的代码气味问题。

## Spec

最终未解决问题：0；首轮确认两项 P2 行为缺陷，见下一节，现均已修复并独立复验。

需求要求“分离提交互斥与观察所有权”“尚未接纳时两个并发 POST 只能 prompt 一次”：最终在权威预查为空后同步竞争 `submission.submitted`，置位与领取之间没有 await；任一仍存活观察可领取尚未开始的唯一提交，已经提交/未知的声明不会再次入队。同身份通过权威 generation 附着旧轮次，不同身份保持 Busy / 未知边界。

需求要求“每观察独立释放，不得取消 Core producer/宿主”：每个观察持有自己的队列、信号、计时器和回调；慢观察溢出与任一断开只清理自身。最后观察结束也不取消宿主；已发出但事实缺失的提交保留未知屏障，权威 GET、原生用户事实或明确拒绝才能解除。错误终态只携带已证明的用户/助手/代次身份，不凭空补助手 ID。

新增 14 项聚焦回归、独立 6 项竞态探针和双侧真实 Core HTTP 受控反馈环均通过。真实模型完整 Core HTTP、运行中 Core 重启、双重启历史、正式部署和模拟器仍需主任务继续，不由本审查宣布这些要求闭环。

## 首轮确认并已修复的两项缺陷

首轮头为 OAI `abdf145e13bd7e9f519e1df12d50c2a9bfcac67a`、DSH `5305e4e39085a20755724814d99f7d10b914a6c8`；首轮新增 11 项回归已全过，但以下独立窗口仍失败。

### P2：首观察在只读预查期间离开，存活观察不能接手尚未执行的首次提交

首轮 OAI `index.js:317` 用 `ownsSubmission` 局部常量指定首个观察，`:544` 只允许该观察 prompt。两个同身份观察都已进入权威历史查询，首观察在查询期间断开，第二观察随后查到空历史，仍没有提交权；结果 **promptCount=0，第二观察只得到 OUTCOME_UNKNOWN**，用户实际输入未执行。此时没有任何可能已发出的提交，不能把它当真实受理未知。两桥都复现。

原始独立复现：[脚本](reattach-independent-pre-admission-probe.mjs)、[输出](reattach-independent-pre-admission-results.json)。最终修复在 OAI `index.js:543` 至 `549` 改为同步检查/置位 `submission.submitted`，允许活跃观察领取确定未开始的第一次提交。新增最后一项正式回归及独立最终探针均确认 **promptCount=1、done、监听器 0**；迟到的首预查返回不重投。

### P2：旧 prompt 的迟到传输失败抢先终结另一个观察的权威预查

首轮 OAI `index.js:504` 至 `506` 的 `admission.fail` 不等待 `lookupComplete`。第二个同身份观察正在读取已持久原生身份时，旧 prompt promise 的传输拒绝向所有观察广播 fail，第二观察立刻结束为未知并解绑查询回调；随后 readSession 返回原生受理事实也已无法附着。两桥结果均为 **promptCount=1，第二观察只有 OUTCOME_UNKNOWN，缺少已存在的 generation**。这是可用的重附被旧传输失败截断，没有发生重复 prompt。

原始独立复现：[脚本](reattach-independent-late-rejection-probe.mjs)、[输出](reattach-independent-late-rejection-results.json)。最终 `index.js:504` 至 `506` 先等待本观察预查完成，共享 claim 仍缓存传输结果；有原生事实时按 generation 恢复，没有事实时才结束为未知。最终独立探针用更强窗口验证：不广播实时原生事件，仅由挂起 readSession 在旧传输拒绝后返回完整持久终态，第二观察仍获得 **generation → done**，promptCount 保持 1。

另核对开发自查补充的 `index.js:380` 至 `382`：观察接到有效原生 user ID 后立即标记权威受理，后续 Agent 从活动表卸载也不会把已有原生事实误当永久未知；对应新增回归通过。

## 最终关键边界

| 检查事项 | 当前实现与结果 |
| --- | --- |
| 单次提交与多个观察 | `index.js:305` 至 `325` 建立/加入共享声明；`:543` 同步领取唯一首次提交。并发同身份只一次 prompt；一个观察结束不影响另一个。 |
| 未知与明确拒绝 | `releaseSubmission`、`observeAdmission` 与 `generationProjection` 按事实释放；空回执/传输失败不当作明确拒绝，不重投；迟到 `{accepted:false}` 在无观察后可释放，GET 确认原生身份后允许后续输入。 |
| 跨轮次隔离 | `releaseSubmission` 的 `claims.get(claim.id) === claim` 防止旧对象清理新对象。独立探针确认旧轮已终态但 prompt 仍挂起，新轮声明已建立时，旧拒绝不结束新观察、不解除新 Busy。 |
| 慢消费者 | 每观察仍使用 128 帧/1 MiB 上限和独立 drain 期限；14 项回归覆盖慢观察溢出，快观察继续 delta/终态，后附观察不重投且 drain 监听移除。 |
| 观察独立清理 | `finally` 清本观察计时器、HTTP close/error、宿主事件/流监听、查找回调、attempt 集合并移除自己的 admission；没有取消宿主句柄。最终独立探针未处理拒绝为 0；Core 反馈环终态后宿主监听为 0。 |
| 错误身份 | `turnResult`、未知终态附带已经取得的 identity；没有助手消息的原生失败只有用户/代次身份；完成/失败冷重放不新增提交。 |
| 安全与数据边界 | 未修改认证、HMAC payload/proof、部署会话范围、设备授权、原生持久 ID 或历史文件。所有独立测试使用新建合成账户/会话/事件，未加载生产配置或私人正文。 |

## 本次实际独立执行与结果

1. 最终 OAI 运行单一 `reattach.test.js`：**14/14 通过，0 跳过**，不是重新运行完整 Node 全套。日志：[最终聚焦](reattach-independent-final-node.txt)。运行命令为 `node ../../node_modules/vitest/vitest.mjs run integrations/dsh-session-adapter/reattach.test.js`。
2. 最终两桥执行 [独立探针](reattach-independent-final-probe.mjs)：**6/6 通过**，覆盖上面两个已修复缺陷及旧轮迟到失败/新声明隔离。见 [最终输出](reattach-independent-final-results.json)，`unhandled=[]`。首轮红结果完整保留，未覆盖。
3. 最终两仓分别执行 `git diff --check <base>...<head>`：通过；独立插件运行 `OAI_UPSTREAM_ROOT=../dsh-stream-reattach node tools/verify-upstream-drift.mjs`：**11 对通过**，见 [漂移结果](reattach-independent-final-drift.txt)。
4. 最终独立运行既有 `core-http-reattach-probe.py`，分别加载两侧原样桥与指定最终 Core 源码：**2/2 通过**。输出：[内置桥](reattach-independent-final-core-http-builtin.txt)、[独立桥](reattach-independent-final-core-http-standalone.txt)。结构化摘要：[总结果](reattach-independent-review-results.json)。

两次 Core 反馈环都使用真实 `create_core/create_app`、注册认证和 HTTP/SSE；宿主事件由受控夹具提供，**模型请求 0**。客户端首次在 generation 后断开时，原宿主观察仍有 2 个监听器且任务 running；第二观察收到同一 generation、delta、done，观察期间 4 个监听；终态后 0 监听、promptCount 始终 1。两个自有夹具进程均退出。预期断开触发的 `ClientConnectionResetError` 日志保留，没有被误标为宿主失败或取消。

开发阶段两仓完整 Node 147/104 项、Core 102 项及增量 6 项、类型门禁不是本审查独立重跑数量。开发 dirty 期间曾运行的反馈环不作为最终固定提交证据；上述两次最终反馈环在清洁的固定头上重新执行。

## 验收范围

本次属于源码、合成竞态与真实 Core HTTP/原样桥的受控证据，未启动真实 DSH/模型进行端到端测试，也未操作正式服务、设备或 UI。真实模型完整恢复/取消/重启矩阵、正式服务部署和模拟器验收由主任务继续。

未知提交屏障是进程内最小安全记录，不承诺任意宿主永久失去原生事实后仍自动恢复，也不承诺跨重启恰好一次。首轮两项已修缺陷需要保留在最终审查记录中；最终未再发现需要阻断本轮修复的新问题。

双轴计数：Standards 最终 0 项；Spec 首轮 2 项已修、最终 0 项未解决。


## 入库打包说明

以上最终审查头是执行源码的固定审查点，后续仅文档/证据提交未改变执行逻辑。归档版三份 Node 探针将原工作树静态导入替换为两个显式入口参数，其余场景和断言不变；运行方式为 `node <本目录探针.mjs> <内置index.js> <独立index.js>`。归档 Core HTTP 探针默认输出到系统临时目录。历史红探针需对照当时源码运行，输出不被当前通过结果覆盖。真实模型原始运行结果没有推送；根因文档只链接移除模型配置、账号、地址、随机会话ID、时间戳和凭据读取元数据后的字段白名单摘要。
