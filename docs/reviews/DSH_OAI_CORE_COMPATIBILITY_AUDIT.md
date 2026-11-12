# DSH Android Gateway 修复后审计与 OAI Core 最终验收

修复后核对日期：2026-11-12（北京时间）。总跟踪：[DSH #1](https://github.com/1rua/dsh-android-gateway/issues/1)。本文前半部分给出修复后事实；[后半部分完整保留 2026-11-11 原审计](#原始审计完整保留)的基准、问题、失败、源码位置和证据，不将历史“未验证”“尚未实施”当作当前状态。

**原八项缺陷及实施中新增问题已取得双仓修复、独立审查与对应层级的成功证据。** 两桥分别完成真实官方 DSH＋完整 Core HTTP/SSE＋既有专用真实模型的 **28/28** 检查；原隔离 Android 用户 10 覆盖同签名 APK 后，旧取消会话重开、历史回读、后继真回复完成与原生会话重命名成功。本机最终精确更新后，重新 HMAC 注册、原实例/范围、全部既有会话能力、运行源码摘要和单 Bundle 均核验成功。

**DSH 与当前 Core 的已测会话链路可用，整个修复目标尚未完成。** 两桥各28/28的真实 Core/DSH/模型证据和原用户10的历史、取消、重命名与真实TCP中断恢复仍有效。后续队列现场出现过短暂本地保存失败提示，原始异常根因尚未确认；Android恢复修复、当前OpenClaw契约协调和最终同提交Full/模拟器复测必须完成后，才能作最终发布判断。

## 0. 2026-11-12 最终收口状态

| 项目 | 当前事实与剩余条件 |
| --- | --- |
| 原八项及新增规模、历史、重附缺陷 | 双仓已合并并部署；源码摘要和分层证据见下文。局部测试不扩展为任意故障保证。 |
| OAI #158/#159/#164 | PR162/163已修复备份Lint、历史Hermes验证边界和测试夹具假阳性；原Full失败仍保留。 |
| Full43094885415 | completed/failure，head02ad53e0；PR143合成merge105d9d5b与dev整tree相同。历史Hermes70/70和备份Lint通过，#169/#170新增失败已分别修复并合并；最终dev Full43129391533仍在执行。 |
| OAI #169 | PR171已合并7e4c5e82：固定日志被第二真实夹具截断，现按实例隔离，保留真实回复、执行次数和本会话/输入身份断言。受控同症状红绿、Debug/Release各5例、独立绿重放1例及PR门禁通过。 |
| OAI #170 / OpenClaw | 外仓PR4已合并e73ddfe1同步4源/4runtime及实际manifest摘要；OAI PR172固定不可变SHA/锁行已通过双轴审查，最终集成CI待完成。严格checker不弱化。 |
| OAI #165 / PR168 | 已合并5ffc613f，修复checkpoint attempt、来源身份、失败writer后pending重启和同源传播；16聚焦绿、真实SQLite1、独立7绿及PR门禁通过。原始模拟器首次保存失败仍未定位。 |
| OAI #142 | generation精确查询与能力门禁已修复，Core聚焦5+30通过；原用户10 Core重启队列复测两条输入/回复各1、历史稳定、最终UI稳定，但恢复过程中出现一次保存失败提示，因此继续开放。 |
| OAI #166/#167 | 单次测试失败在固定提交的失败作业重跑后通过，按未稳定复现关闭；首次失败和证据边界保留。 |

本机后续只读复核再次确认Core/DSH均active/running、NRestarts=0；54/54 Core Python源匹配02ad53e0；fresh HMAC、原实例与scope、全部既有会话能力、三组JS摘要和单活动Bundle通过。仅核验服务和桥认证，没有读取生产会话正文或发送消息。

设备通路后续证据：CLI和官方MCP stdio在原隔离用户10发现同一设备及Schema；系统无障碍关闭时准确返回ANDROID_PERMISSION_REQUIRED，按系统确认恢复后发布READY。CLI一次state读取与MCP稳定屏幕上一次新state读取都完成单次本地确认、succeeded、摘要、ACK和正文释放。MCP首次SCREEN_CHANGED失败保留，不以一次成功抹去失败；只说明这一只读能力及所测通路，不宣称全部设备能力通过。

**当前发布判定：尚未完成。** 最终dev Full43129391533已失败1项ColdStartConnectionTest，失败作业正在重跑；真实用户10 Core重启队列复测两条输入/回复各1、历史稳定、最终UI稳定但观察到一次保存失败提示，#142继续开放。最终APK保留数据覆盖、Full和报告闭环仍是关闭条件；见[最终收口计划](../plans/2026-11-12-final-closure.zh-CN.md)。
## A. 修复后总体结论

| 六个主要问题 | 当前结论与直接证据 |
| --- | --- |
| 能否连接 Core，连接是否稳定？ | 已验证真实注册、Bearer/HMAC、完整 Core 登录与发现、Core 运行中重启和 DSH/Core 双重启；本机最终重新 HMAC 成功，目标服务 active/running、NRestarts=0，三次授权健康约 0.154—0.309 秒。只说明所测运行和恢复范围，不外推长期稳定、无缝 Token 轮换或任意网络故障。 |
| 会话功能是否可靠？ | App 路径创建、原生控制器新建后 Core 发现、标题/活动时间、历史原生身份、重命名、重启回读、原 user10 旧数据均有证据。305 合成空正文会话与十五万事件摘要回归通过；真实终端图形界面双向操作没有独立 UI 证据。 |
| 消息、取消与恢复是否可靠？ | 两桥完整 Core 的增量/终态、同身份运行中重附、同身份回放不增加原生输入/请求、精确取消、旧目标隔离、运行中 Core 重启后 GET 恢复和双重启冷回放均通过。Android旧数据刷新/重开与后继完成、真实TCP断开12秒后原输入/回复各1且历史保留均通过；未知事实永久缺失、任意跨故障精确一次及所有排队时序不在该证据范围。 |
| 是否仍有阻碍正常使用的已知 Bug？ | 原八项与新增规模、历史、重附缺陷均已有修复及回归/现场证据，最终独立审查未解决 Standards/Spec 问题各 0。原#158/#159已修复；当前#165仍需最终集成与现场复测，#170当前固定契约协调待OAI集成。原Full与本机环境失败保留，不把单项补跑当成整轮成功。 |
| 是否有关键功能缺失，责任在哪里？ | 附件、原生命令/模型切换、结构化工具/审批、归档/删除、eventSync 仍不支持；本轮没有承诺扩展。设备认证/绑定/调度由 Core、执行和本地授权由 Android 负责；一项真实只读 state API 的授权、结果消费和 ACK 释放通过，不能推成全部设备能力已验收。 |
| 是否已满足完整发布门槛？ | 现有会话/文字/精确取消/生成恢复的本轮修复及本机支持范围验收已通过；54个Core Python文件和双桥JS实际摘要匹配最终源，真实TCP中断恢复通过。完整仓库发布仍未达标：#158/#159已修复，后续Full43094885415仍失败并显露#169/#170；#169已合并，#170、#165及最终模拟器复测待收口。PR矩阵不替代Full。 |

### 固定快照、运行版本与已合并交付

| 对象 | 固定来源 |
| --- | --- |
| 原审计独立 / OAI | `325a48058dafbfdb0686dc060e08674d8810b4c1` / `24172841f9a564c53416f7d066f3450d4feb2bfe`；详见保留原文 |
| 最终独立合并 | DSH #13，`d60931342780ef73296db07d96d9b5f3687f16e1`；本报告分支从此建立，仅改 docs |
| 最终 OAI 合并 | OAI #154，`74c007570ecf8a90b0edea96893500d1b995bf00` |
| 双28实际执行提交 | Core/内置 `6efbd0c6c45b9776cf9c38b7f19d37b4073b18c2`；独立 `8bd40eaa49c4b60fcf9aea554faaeb83cad4baf1`；后续仅证据/说明增量，实际 JS 摘要与最终运行逐项一致 |
| 实际宿主及模型 | DSH `0.2.2-rc.1`；专用白名单 `sub2api / deepseek-flash / high`。不修改真实默认模型，不复制模型密钥；不宣称这是上游最新发行版 |
| 运行器 | Node `v26.7.0`；最终门禁另使用带 DSH 的 Node24 PATH；Python `3.14.6`，pytest `9.1.1`、aiohttp `3.14.5`；最终内置147项与独立104项均实际使用共享 Vitest `4.1.10`；独立package/锁定依赖为Vitest `3.2.4`，不能将锁定版本当作这次实际运行器；Android JDK21 / SDK36，保留各日志实际版本 |
| 现行全部lanes CI快照 | `ef09a03e80716565299086322a69bc5cdb8aa3d1`；在74c之后含其他任务设置UI增量，运行43079814644成功；不是双28执行源码，也不是74c原Full的成功重跑 |
| 原 user10 最终历史 APK | 源 `0e5b636735819f0c24ae5da1350e2e70e5aa559c`；SHA256 `33edbe4a3a8019b01b08c8f2ff47a2487445ec2ef90b52b7f67a22006b03e042`；六内建包已验、签名相同、保留原数据覆盖 |

[独立桥完整 Core 28 项](2026-11-12-core-stream-reattach-artifacts/standalone-core-http-final-public-summary.json)、[内置桥完整 Core 28 项](2026-11-12-core-stream-reattach-artifacts/builtin-core-http-final-public-summary.json)分别保存固定来源与原结果 SHA256。运行入口摘要为独立 `4feb77fbd23ff9a00a65cfffe8ade90acf67fa0727454382a6797adb7863cebe`、内置 `54bec1dd68ae8fd5f0beeea064d05a5fc16a80e6e40cf5e9373d03aaa2153caa`；共同 generation.js 为 `b930781fff17d9c6370e9a290658648fd61c6909edf5294dfc632f3d1774e195`。本机最终[白名单核验](2026-11-12-final-acceptance-artifacts/production-final-public-summary.json)按部署角色列出三组入口/生成/诊断摘要，全部匹配。

## B. 问题根因、修复结果与十三类交付

下表使用原 AUD 标识，保留根因来源与后续发现，不把“独立与内置不同”单独定为缺陷。源码位置按独立最终 `d6093134`：`src/index.js` 的能力 95—118、摘要 197—225、stream 258—566、恢复路由 595—618、历史 630—650、取消 662—686；`src/generation.js` 的生成投影 11—96、匹配 99—105、取消 118—137。原始精确位置及复现保持在后半部；OAI 安装和 Android 修复位置由相应固定审查引用。

| 类别 / 原问题与 issue | 确认根因及交付 | 当前结果 / 证据 |
| --- | --- | --- |
| 1. 开发基线与注册 / DSH #1、#7 | 远端 dev 落后握手修复，先有选择地引入已验证握手和测试，不盲覆盖全部 main 差异。 | #7 合并 `37d181a`；实际 HMAC、身份库注册与真实宿主加载通过。没有把历史缺 handshake 当作本轮新问题。 |
| 2. AUD-001 精确取消 / DSH #2 | 原宿主会话级 cancel 忽略 generation；改为读取真实活动 Agent/轮次并同步匹配，过期目标不作用于新任务。 | 两桥取消/竞争回归与真实 Core cancelled、旧完成目标 already_completed 均通过；原 user10 实际停止为 running→cancelled，后继完成。保留 cancel，不以禁用能力交付。 |
| 3. AUD-002 受理/观察生命周期 / DSH #3 | 原 await prompt 阻止 finally，断连/超时/先终态不能清 Busy；拆分回执与观察，晚回执安全消费。 | 回归覆盖挂起、断连、超时、晚拒绝与监听清理；真实断观察不取消，最终同身份重附与原任务完成。后续 Core 旧观察窗口另列13，不能把两根因合并。 |
| 4. AUD-003 稳定消息身份 / DSH #4 | 原随机请求 ID、缺 client/native/rpcId 关联；协商稳定客户端身份，保留真实用户/助手/代次身份与历史来源。 | 双侧 #8 / OAI #145 交付；实时/历史、重复 POST、重启与冷回放证据具备。后续 Android 占位升级另列12；idempotentSend=false，不能宣传普遍精确一次。 |
| 5. AUD-004 背压 / DSH #5 | 原忽略 write=false，出站观察无界；复用有界队列、drain/期限与独立清理。 | 128帧/1MiB观察预算、2000帧、恢复/永久drain、慢观察溢出与快观察继续均有受控回归；正常模型流不当成压力测试，未制造生产OOM。 |
| 6. AUD-005 长历史摘要 / DSH #6 | Math.max 展开全部事件触发参数上限；改迭代摘要，保持全部会话和错误事实。 | 两侧十五万事件与正常/长历史共存回归通过；实际多会话全库放大后续另列11，不用单侧关闭共享问题。 |
| 7. AUD-006 目标 Profile 重启 / OAI #140、#144 | 固定dsh.service与模糊PID停止未绑定所选Home/Profile；沿安装/重启/注册保留目标事实并核验进程。 | #144 合并 `32b453e`，独立三轮收敛；真实PID后备双宿主9项和非目标60次健康通过；活跃模型补验11项与354次健康通过，见下文。非双systemd unit证据。 |
| 8. AUD-007 prompt 参数 / OAI #141 | 内置删除真实宿主必需 signal，入口TypeError误报未知；提供与观察生命周期分离的受理signal。 | 内置真实模型完成、断观察后继续和双28通过；没有让观察断开取消Core producer或宿主任务。 |
| 9. AUD-008 权威生成/队列恢复 / OAI #142 | 原缺current/generation路由和持久事实，客户端send门禁不能代表恢复可用；双桥按原生投影与能力协商恢复，未知保留屏障。 | 完整Core运行中重启GET恢复、DSH/Core双重启、稳定身份冷回放通过；不自动重发，永久缺事实不伪idle。最终所有Android断网/排队排列未逐一穷举，不能写全部Queue故障已验。 |
| 10. 内部上下文与连接状态 / DSH #9、OAI #146/#147 | 四类内部来源被投成人工历史；全局LIVE未显式映射导致空闲状态回退。精确过滤内部来源，补连接投影，保留普通用户/旧来源/助手。 | 双桥direct/wrapped回归和独立审查；#147 合并 `688e2b81`。最终用户10连接/历史/重开正常，结构化工具与附件仍未支持；空闲/重连/故障所有UI状态不因单截图一并标绿。 |
| 11. 大会话查询放大 / OAI #148/#149、DSH #10/#11 | 每个摘要重复全库投影与读取，305会话使健康/列表超时；单次目录枚举、官方精确观察、未发布投影、共享有界读名额与租约释放。 | OAI #149 `ec2015b4`、DSH #11 `c4451154`合并；[独立审查](2026-11-12-dsh-corpus-scaling-artifacts/corpus-final-independent-review.md)两轴0；305合成服务/资源、并发取消/迟到租约全过。本机授权健康3次与最终注册通过，不声称任意正文/第三方插件规模。 |
| 12. Android 历史占位升级 / OAI #150/#151 | 已受理客户端占位与权威原生ID冲突，导致MESSAGE_ID_CONFLICT；只允许同会话同client明确占位单向采用原生ID，拒绝真实ID替换/跨客户端/跨会话，迟到占位不降回去。 | 独立5项真实加密镜像/仓储链、10项编译身份探针及PR门禁 App1258+关联模块963通过；原用户10旧取消会话重开无冲突/历史错误，后继真实回复completed、同native会话重命名回读成功。 |
| 13. Core 旧观察下运行中重附 / OAI #152/#154、DSH #12/#13 | Core生产者继续持有旧桥观察，而桥busy锁观察寿命，第二同身份观察被SESSION_BUSY拒绝；拆提交声明与每观察所有权，唯一首次提交同步领取，旧回执不能清新声明。独立审查又发现预查中首观察退出不能交接、迟到拒绝抢占权威读取，两项均修复。 | [独立审查](2026-11-12-core-stream-reattach-artifacts/stream-reattach-independent-review.md)14回归+6竞态+2受控Core反馈环通过；双侧最终完整Core真实模型28/28，原生输入不重投，最后监听0。两仓已合并，生产精确源码/HMAC已核验。真实失败与首轮红结果完整保留。 |

### 本机更新、原数据与模拟器现场结果

本机精确更新保留原选定 Home/Profile、账号、Agent manifests/key digests、account links 与 Core config；最终重新 HMAC、相同实例/部署范围、全部既有会话能力、运行模块摘要、单 active dsh-android-gateway 均成功，Core/DSH 服务 active/running，NRestarts=0。生产核验没有读取真实会话正文、没有发真实消息；不能从健康推断已验证所有私人历史正文。最终比较初次发现54个Core Python文件中53个已匹配，唯一旧`gateway/transport.py`缺少结构化replay诊断和heartbeat响应头；在私有备份后精确更新并重启Core，[54/54比较](2026-11-12-final-acceptance-artifacts/production-core-final-source-comparison.json)现全部一致，[更新摘要](2026-11-12-final-acceptance-artifacts/production-core-transport-update-result.json)确认未更改凭据或会话。随后重新HMAC和服务状态核验仍通过。[最终部署白名单](2026-11-12-final-acceptance-artifacts/production-final-public-summary.json)不含PID、私有目录或系统身份库结构。

[原生数据保留摘要](2026-11-12-final-acceptance-artifacts/production-retained-data-after-corpus.json)明确：**1140个原路径全部保留，但不是所有文件属性逐字未变**。一个空lock的mtime变化；一个既有v4压缩日志追加80字节空session/end-seed内部标记，仅读取旧尾部之后新增帧的[信封元数据](2026-11-12-final-acceptance-artifacts/production-native-appended-frame-metadata.json)，没有读取旧正文。主密钥属性由前序核验保留；不写“所有文件从未持久写入”。

原用户10已在[同签名六包APK](2026-11-12-final-acceptance-artifacts/history-final-apk-evidence.json)覆盖后[重开旧取消会话、读历史、继续发送完成](2026-11-12-final-acceptance-artifacts/history-fixed-reopen-result.json)，无MESSAGE_ID_CONFLICT与历史失败提示，取消输入保留；[重命名经Core回读](2026-11-12-final-acceptance-artifacts/history-native-rename-summary.json)确认同一nativeSessionId与目标标题。该APK执行身份已固定。最后使用与双28相同最终执行模块的隔离Core/DSH，在同一user10完成[真实TCP中断恢复](2026-11-12-final-acceptance-artifacts/emulator-final-tcp-outage-public-summary.json)：UI只发送一次，确认原轮次running后主动关闭2条既存TCP并停止Core监听，独立GET确认不可达；12秒中断期间UI没有误报已连接。恢复后原轮次completed、原生用户输入1/回复1、旧历史ID保留、回复标记可见、UI重新已连接，无历史冲突或残留停止/Busy状态。此前仅移除adb reverse/监听的结果没有证明既有TCP断开，因此未当作真实断网归档。这是隔离Core/DSH同源码与原user10的验收，不是在生产私人历史中发消息。

生产公开入口另完成[账号登录与原DSH发现](2026-11-12-final-acceptance-artifacts/production-public-auth-result.json)：认证和Agent发现成功，两个既有Agent中DSH为online；未读取真实会话列表/正文、未发消息、凭据未落盘。部署服务与隔离App验收的证据分别报告，不能互相冒充。

[双Profile活跃任务摘要](2026-11-12-final-acceptance-artifacts/dual-profile-active-public-summary.json)为11/11通过，目标重启约0.208秒，非目标PID/启动/参数/环境/目录不变、原真实generation完成、354次健康0失败（最大30.17ms）、一次用户输入与一次请求、2个监听全部释放、目标无消息、原配置/凭据指纹不变、全部自有进程退出。`followStarted=0`，不把未触发follow记为执行。首次工具误检查旧Popen产生SYNTHETIC_HOST_EXITED失败，保留在现场记录；修正只等新PID后，以新Home新输入再验一次通过，没有重投未知输入。此项是真PID后备，**不替代双systemd unit**。

[设备state与ACK白名单摘要](2026-11-12-final-acceptance-artifacts/device-state-ack-public-summary.json)只归档requestId散列、状态、1080×2400/rotation=0、nodesEmpty、ACK和正文释放。实际经历pending→claimed/awaiting_confirmation→succeeded，用户10本地授权生效。脚本自身不含Android userId映射，目标由主任务在原user10上下文核对；不输出账号、设备ID、全能力目录或屏幕元数据。该一项只读API成功不等同通知/短信/屏控、CLI/MCP全部验收。

最终独立源码可按永久提交定位：[摘要与资源路径](https://github.com/1rua/dsh-android-gateway/blob/d60931342780ef73296db07d96d9b5f3687f16e1/src/index.js#L197)、[提交声明与观察分离](https://github.com/1rua/dsh-android-gateway/blob/d60931342780ef73296db07d96d9b5f3687f16e1/src/index.js#L258)、[原生生成与精确取消](https://github.com/1rua/dsh-android-gateway/blob/d60931342780ef73296db07d96d9b5f3687f16e1/src/generation.js#L118)。这些链接仅定位源码，不把远端源码阅读当作额外执行证据。

## C. 修复后功能矩阵与责任边界

五态固定为：**通过**（注明层级）、**有Bug**（已复现且尚未修好）、**未验证**（有实现或计划但缺该层证据）、**不支持**（无通路或能力关闭）、**Core负责**（不计插件缺失）。下面各行可以同时注明直接桥、Core与UI证据差异；状态不是“测试通过即产品全正常”。

| 功能 | 双桥 / Core / Android当前状态 | 证据或边界 |
| --- | --- | --- |
| 加载、注册、Bearer/HMAC与健康 | 通过：真实宿主、完整Core、本机最终注册 | 最终管理员HMAC与能力为准；半注入早期create/send=false记录仍保留，不代替最终状态 |
| 列表、App创建、原生新增发现、标题/时间 | 通过：完整Core双28；原user10发现与历史 | 305合成列表与十五万事件回归；真实终端图形界面双端操作未验证 |
| 重命名、持久文字历史和应用重开 | 通过：Core/DSH重启、原user10同nativeID回读 | 非文字历史不支持；原生ID/来源关联通过，私人正文未读 |
| 文字增量、完成/失败、身份关联 | 通过：双28完整Core成功/取消与受控失败终态；Android真回复 | 最终同源码隔离Core/DSH与原user10真实TCP中断恢复通过；未验证所有上游模型失败形态 |
| 精确取消、旧目标与后继 | 通过：双桥真模型、Android停止与后继completed | 保留原取消能力；不是禁用cancel换取绿灯 |
| 同身份重附、重复POST、Core运行中重启、双重启冷回放 | 通过：双28及独立受控窗口 | idempotentSend=false；未验证任意跨故障精确一次 |
| 同会话排队、未知结果、网络恢复全部排列 | 通过：受控屏障/不重投、Core恢复及原user10的12秒真实TCP中断恢复；未验证：全部网络/排队排列 | 不说所有Queue坏，也不说所有故障排列正常；未知保留且不自动重发 |
| 慢消费、有界队列、长历史、多会话隔离 | 通过：受控2000帧、drain/租约/竞态/十五万事件/305空正文 | 未验证任意大正文、第三方插件、长时间内存稳定、真实多账号压力 |
| 归档/删除 | 不支持 | archive=false、delete=false，维持原支持范围 |
| 附件输入、原生图片/文件历史 | 不支持 | Core/Android附件接口存在不等于DSH桥支持；本轮不扩功能 |
| /new命令、模型切换和DSH原生命令 | 不支持命令通路；App create API通过 | /model作为普通文字不算模型切换 |
| 工具/结果结构化显示与宿主审批 | 不支持桥事件/决策映射 | Core/Android有执行步骤/审批API；本次真模型toolEvents=0不能证明工具或审批 |
| 持续事件同步、历史events/ack | 不支持eventSync | 当前为主动查询和generation恢复；与设备结果ACK分开 |
| Android设备CLI/MCP/API | Core负责，Android本地授权/执行；通过一项state API | 其他设备能力与CLI/MCP入口未验证；桥Token不拥有设备授权 |
| 安装升级、目标重启、数据保留 | 通过：受控安装回归、真实PID后备活跃隔离、本机精确更新 | 未验证真实首次安装/卸载、双systemd unit、所有故障回滚现场 |
| Token重载、无缝轮换、热重载 | 未验证完整现场链 | 本机原key digest/manifest保留通过；不得换身份或真实密钥绕过 |
| 多Profile全自动接入 | 不支持完整自动发现配置；通过所选目标精确操作 | 不另建账号/设备权限系统，不扩大成全自动部署需求 |

当前没有证据要求撤回已固定修复的结论；本机环境和测试工具失败保留在D，不标作新生产P0/P1。未发现P0不等于安全审计证明没有其他漏洞。deployment共享原生corpus为原契约，Core账号不传到DSH；互不信任用户仍需独立受控DSH范围。

## D. 实际命令、结果与可复跑材料

本节数量按层级、提交和命令分别列示，**不能把独立抽样、开发套件、旧审计294项或双侧同类检查简单相加成最终总测试数**。完整Core运行结果只归档字段白名单，不归档runs、原始结果、账号、数据库、ready/login、桥密钥、模型配置/地址或启动日志。

| 验证与实际入口 | 通过 / 失败 / 跳过 | 证据与精度 |
| --- | --- | --- |
| 两侧完整Node：在OAI工作树根执行`node ../../node_modules/vitest/vitest.mjs run --config integrations/dsh-session-adapter/vitest.config.js`；在独立桥工作树根执行`node ../../node_modules/vitest/vitest.mjs run` | 内置147 / 0 / 0；独立104 / 0 / 0 | [内置](2026-11-12-core-stream-reattach-artifacts/reattach-final-builtin-node.txt)、[独立](2026-11-12-core-stream-reattach-artifacts/reattach-final-standalone-node.txt)；真实宿主可选项在这次完整套件执行 |
| Core DSH契约pytest + 最小竞态增量 | 102 / 0 / 0；增量跨语言1个pytest用例 / 0 / 0 | [契约](2026-11-12-core-stream-reattach-artifacts/reattach-core-contract.txt)、[跨语言](2026-11-12-core-stream-reattach-artifacts/reattach-final-core-cross-language.txt)；增量日志实际为1 passed，用例内含多项协议断言，不能写6个pytest通过；不同轮次，不相加冒充同一套件 |
| 类型与`OAI_UPSTREAM_ROOT=... node tools/verify-upstream-drift.mjs` | 类型成功；11对一致 | [类型](2026-11-12-core-stream-reattach-artifacts/reattach-final-typecheck.txt)、[漂移](2026-11-12-core-stream-reattach-artifacts/reattach-final-drift.txt) |
| 独立审查14项正式回归、双桥6竞态、两侧CoreHTTP受控反馈环 | 14 / 0 / 0；6 / 0；2 / 0 | [独立结构化结果](2026-11-12-core-stream-reattach-artifacts/reattach-independent-review-results.json)，模型请求0，不能计作真实模型 |
| 完整Core＋真实官方宿主＋模型 | 独立28/28、内置28/28，清理成功 | 上文双28白名单；原生eventCount各38，工具0、重试0、原生失败码空；独立重附约8.219秒、内置10.071秒 |
| 原Android历史PR门禁 | App1258 / 0 / 0；domain47+UI855+data61=963 / 0 / 0 | [逐模块计数](2026-11-12-final-acceptance-artifacts/history-placeholder-pr-jdk21-counts.json)；源0e5b6367。独立5项与10探针是另一层证据，不重复计数 |
| Full后续Android模块恢复任务 | XML2279 / 0 / 0 | [23模块清单](2026-11-12-final-acceptance-artifacts/full-module-final-xml-inventory.json)；不包含App1258，不等于完整Full全绿 |
| `npm run test:full`完整本机链 | 尚无完整成功；保留1项既有Hermes venv lib64 symlink ENOENT | 宿主权限复核同样失败；此前缺jszip、系统Python与历史fixture错误已分别补依赖/解释器/固定fixture并定向补跑，机器重启中断不算通过 |
| 最终Fast与PR门禁 | Fast147全过；PR146过/1失败，同一旧install测试单项补跑通过 | [Fast](2026-11-12-core-stream-reattach-artifacts/reattach-final-fast.txt)、[PR失败](2026-11-12-core-stream-reattach-artifacts/reattach-final-pr.txt)、[补跑](2026-11-12-core-stream-reattach-artifacts/reattach-install-abort-focused-recheck.txt)。失败为原10ms回滚测试recovery目录时序，未改源码/断言，整轮仍失败 |
| 较早Fast/PR的可选宿主层 | 139过 / 0失败 / 5跳过 | PATH缺DSH的该轮明确跳过；不以该轮宣称真实宿主层执行；最终完整Node单独覆盖 |
| 原最终dev Full CI | completed / failure | `ci.yml`，head74c00757，run43077533569；Node历史Hermes契约pin与Android StringFormatMatches两项既有阻塞，后续相关步骤跳过，不能填写通过 |
| 现行Core全部lanes矩阵 | completed / success | `oai-core.yml`，head ef09a03e，run43079814644；Core3.11/3.12、Hermes、DSH、Android全部lanes与CI Gate成功。该头包含其他任务设置UI增量，且工作流未覆盖历史pin、Lint/assemble/APK完整性，不能代替原Full |
| 原user10最终TCP中断恢复 | passed=true，单输入1 / 回复1 | 关闭2条既有TCP+停止监听，独立GET确认不可达12秒；恢复后原轮次完成、旧历史ID保留、UI恢复、无冲突/残留Busy；仅adb reverse移除案例不作为真断网证据 |

### 原Full历史失败责任与现行矩阵的独立证据

[CI白名单摘要](2026-11-12-final-acceptance-artifacts/final-ci-public-summary.json)记录本次直接单次回读的两次运行状态：原Full `43077533569`在`74c00757`为completed/failure，现行全部lanes `43079814644`在`ef09a03e`为completed/success。没有watch或前台阻塞轮询。原Full两项失败分别由[OAI #158](https://github.com/1rua/open-android-intelligence/issues/158)与[OAI #159](https://github.com/1rua/open-android-intelligence/issues/159)单独负责：

- 历史Hermes fixture固定`ebe527da2426dd25877dd335786e80cf85d1cdde`，其契约pin `f0b3f1bd4f6f3301b820e38c9f3241bcac05cd10`与当前四类协议受管路径不相同；差异在更早的`17895223c16fc84dfbe7c889943a608f7fbaa095`已出现。原审计基线24172841到最终74c的这些路径完全相同，本轮DSH没有引入差异。不能通过随意更新外仓pin、删断言或跳过门禁掩盖。
- Android `SettingsBackupPresentation.kt:11`将Double传给`%1$s`，`lintFullDebug`报StringFormatMatches。Kotlin与`strings_settings.xml:78`在基线24172841和74c的blob完全相同，属于既有文案类型契约错误。Android构建失败后的插件入APK完整性步骤被跳过，不能记为已执行通过。

现行`oai-core.yml`全矩阵成功补齐当前Core/适配器/Android测试证据，但没有运行上述Lint、APK assemble、完整性与历史pin门禁。即使这些基线阻塞非本轮DSH回归，整个仓库的发布标准仍未满足；本轮DSH支持范围验收可以独立判为通过。

### 复跑入口与输出隔离

归档[完整Core真实模型场景脚本](2026-11-12-final-acceptance-artifacts/core_http_reliability.py)依赖同目录的[配置/宿主工具](2026-11-12-final-acceptance-artifacts/run_real_model.py)、[直接桥场景](2026-11-12-final-acceptance-artifacts/reliability.py)和[官方启动入口](2026-11-12-final-acceptance-artifacts/boot-isolated.mjs)。只归档代码，不归档任何真实配置、凭据、运行目录。归档副本只改参数装配：模型配置与0600凭据必须显式引用，输出必须显式放在docs之外；原场景与断言未改，[脚本摘要清单](2026-11-12-final-acceptance-artifacts/reproduction-script-manifest.json)同时记录实际执行来源和归档副本指纹。它们的本次验证是语法/装配检查，**没有以改过装配的副本重新调用模型来冒充原双28执行**。

下列从独立仓库根目录执行，变量必须由已获授权的维护者填写为现有专用配置与0600密钥引用；脚本只取白名单模型、只读凭据并在内存注入，不改变真实默认模型。参数不是要创建或归档新凭据。测试产生的合成身份/会话/原始结果只能留在指定隔离输出，随后只提取白名单摘要，不能提交整个输出目录。

```bash
# 维护者先设置相对路径：CORE_ROOT、MODEL_PATCH、MODEL_CREDENTIALS、PROBE_OUTPUT。
# 独立桥；这会调用已有白名单真实模型。
python docs/reviews/2026-11-12-final-acceptance-artifacts/core_http_reliability.py \
  --core-root "$CORE_ROOT" --adapter src/index.js \
  --model-patch "$MODEL_PATCH" --credentials "$MODEL_CREDENTIALS" \
  --output-root "$PROBE_OUTPUT" --model deepseek-flash --label standalone-core-final

# 内置桥；同一脚本与断言。
python docs/reviews/2026-11-12-final-acceptance-artifacts/core_http_reliability.py \
  --core-root "$CORE_ROOT" --adapter "$CORE_ROOT/integrations/dsh-session-adapter/index.js" \
  --model-patch "$MODEL_PATCH" --credentials "$MODEL_CREDENTIALS" \
  --output-root "$PROBE_OUTPUT" --model deepseek-flash --label builtin-core-final

# 无模型的Core反馈环；输出放隔离目录，不能省成docs原位。
python docs/reviews/2026-11-12-core-stream-reattach-artifacts/core-http-reattach-probe.py \
  --core-root "$CORE_ROOT" --adapter src/index.js --output-root "$PROBE_OUTPUT"
```

独立插件轻量回归可使用已有依赖执行`npm test`、`npm run typecheck`与`OAI_UPSTREAM_ROOT="$CORE_ROOT" npm run verify:upstream`；OAI的实际Fast/PR/Full入口为该仓库根目录`npm run test:fast`、`npm run test:pr`、`npm run test:full`。重跑前固定实际SHA/dirty与依赖版本，保留失败/跳过原因，不更换临时缓存冷启动、不删断言、不重复全量构建。

## E. 交付优先级、残留边界与关闭入口

原计划P1/P2已按责任交付；对应issue是否正式关闭仍由主任务核对远端状态，不以本文代替一次真实远端回读。原8项关闭依据分别是：AUD001精确轮次/旧目标安全，002挂起清理/晚回执，003两侧真实身份与Android旧数据升级，004有界观察/清理，005双侧完整列表与大历史，006目标身份/非目标活跃任务，007真实signal契约，008权威查询/同身份恢复不重投。新增上下文/连接、规模、占位、重附问题采用B中的直接证据；不能用单侧Closes提前结束共享需求。

| 优先级 | 实际剩余事项 | 处理与结论边界 |
| --- | --- | --- |
| 全仓发布阻塞，独立修复 | 原Full43077533569失败，OAI #158历史pin与#159文案Lint | 两项均基线已有、非DSH引入，仍须各自修复并在明确SHA取得Full/构建/完整性证据。现行ef09a03e矩阵成功不能抵消；本报告不宣称全仓发布达标 |
| 门禁环境缺口，明确保留 | 本机Full的Hermes lib64符号链接ENOENT及旧安装10ms时序失败 | 环境/测试事实与产品缺陷分开，不删除断言；分段2279成功与单项补跑不能覆盖整轮失败。远端Full即使成功也应作为独立证据 |
| 支持边界，不扩大任务 | 附件、命令/模型切换、工具/审批、归档/删除、eventSync | 仍明确不支持，不能写“全功能”；没有要求本轮新增这些能力，也不以Core已有接口冒充桥支持 |
| 未验证现场，按实际范围陈述 | 双systemd unit、无缝Token轮换/热重载、真实首次安装/卸载、任意大正文/第三方插件、所有网络与排队排列 | 维持未验证，不追加无关假设检查；PID后备活跃任务、当前本机更新、具体恢复场景已通过的事实保留 |
| 身份/权限与恢复边界 | deployment共享corpus、设备Core/Android职责、未知提交屏障 | 不传账号到DSH，不复制设备授权；事实缺失不伪空闲、不自动重发、不宣称跨故障精确一次；私人会话正文保持未读取 |

本轮DSH支持范围已完成最终源码部署、公开登录发现与原user10真实TCP中断恢复；CI两次运行状态已固定。正式关闭本轮总跟踪前，主任务应完成独立文档审查与远端issue状态核对，并按第0节收口OAI #142/#165/#170及最终Full，更新[实施状态](../plans/DSH_OAI_CORE_IMPLEMENTATION_STATUS.md)及[计划](../plans/DSH_OAI_CORE_REMEDIATION_PLAN.md)中的历史进度说明；把已通过、失败、未验证、不支持与职责归属分别写清。所有文档和白名单材料都在仓库docs内，原始私有运行材料不入库。

---

## 原始审计完整保留

以下为2026-11-11原始报告，内容和路径按当时固定快照保留。原始A—E的“本轮”“当前”“未验证”均指该次修复前审计；今天的结论以上述修复后A—E为准。

# DSH Android Gateway 全面代码审计与 OAI Core 兼容性验证

审计日期：2026-11-11（北京时间）。本轮只审查、执行隔离测试和生成报告；没有修改生产代码、提交 Commit、建立 Issue/PR、操作既有 DSH 会话或 Android 设备。所有新增消息、账号、数据库和桥密钥均为隔离测试数据。

## A. 总体结论

**独立插件能够连接当前 OAI Core，但尚未达到可靠发布标准。** 本轮以真实 DSH `0.2.2-rc.1` 加载独立插件，实际执行了当前 Core 的 HMAC 握手、身份库注册回读、健康检查、会话发现、创建、空历史读取、重命名及宿主重启后持久会话回读。以上限定链路通过；历史上的“缺少 handshake 路由”已经修复，不是本轮缺陷。

**连接稳定性、消息完整性与异常恢复不能判定为正常。** 已复现受理回执悬挂后永久 Busy、取消忽略目标生成轮次、消息身份信息丢失、慢消费者写缓冲缺乏上限，以及长会话拖垮整个会话列表。Core 的安装后重启还可能选错 Profile；内置对照版本则存在与本机实际 DSH `prompt` 签名不一致的反向漂移。因此既不能以独立版本与内置版本不同就定错，也不能建议直接覆盖为内置版本。

| 要回答的问题 | 本轮结论与证据边界 |
|---|---|
| 当前版本能否正常连接 Core？ | **能完成所测连接与注册链路。** 真实宿主 + 真实 Core 库函数验证通过；未运行完整 Core HTTP 登录服务及 Android 登录界面。 |
| 连接是否稳定？ | **不能确认稳定。** 一次真实重启恢复通过，仍有受理悬挂/资源释放缺陷；Token 无缝轮换、热重载及长时间运行未验证。 |
| 会话功能是否可靠？ | 基础创建、发现、重命名和重启保留通过；一个超长会话可使全列表失败。终端 UI 与 App 的完整双向体验未实测。 |
| 消息功能是否可靠？ | **不足。** 正常增量和终态在隔离契约测试通过，但身份、取消、未知结果和背压存在问题。真实宿主的无模型凭据失败路径可返回 `AGENT_FAILED`；这不是模型回复成功。 |
| 是否存在阻碍正常使用的 Bug？ | **存在。** AUD-001、002 可影响任务和后续发送；AUD-006 可中断其他宿主；AUD-007 使对照内置版本在所测宿主上无法正常受理发送。 |
| 是否有关键功能缺失？ | 两版均缺少可靠生成恢复、附件桥接、宿主审批/工具事件和原生命令通路。是否列为发布必需取决于承诺的产品范围，不能标成已支持。设备授权和设备调用仍归 Core/Android。 |
| 是否达到可发布标准？ | **本轮不建议发布。** 先解决 P1 与当前客户端必需的身份/恢复问题，再补隔离真实模型和 Android 全链验证。未发现有证据支持的 P0；这不代表已证明不存在其他安全问题。 |

### 审计快照与“最新代码”的处理

| 对象 | 版本/分支 | 审查提交 |
|---|---|---|
| `1rua/dsh-android-gateway` | 默认分支 `main`，package `0.3.0` | `325a48058dafbfdb0686dc060e08674d8810b4c1` |
| 独立仓库 `dev` | 同时核对分支状态 | `59aad2b0559a950c7b687914eb9089ddf9c8269c`；落后于默认分支的握手修复，不能拿它替代默认分支审计 |
| `1rua/open-android-intelligence` | 用户指定 `dev`，Core `0.2.0` | **最终审查** `24172841f9a564c53416f7d066f3450d4feb2bfe` |
| OAI 执行测试时快照 | `dev` 在审计开始时的提交 | `d5b82cb6f796a08838f3a1136b8fbb77e22c0f49` |
| 实际 DSH 宿主 | 本机已安装发行包 | `@deepseek-ai/dsh 0.2.2-rc.1`，未宣称它是 DSH 上游最新版本 |
| 测试运行时 | Linux，Node `v26.7.0`，Python `3.14.6` | pytest `9.1.1`，aiohttp `3.14.5`；独立 Vitest `3.2.4`、OAI 已安装 Vitest `4.1.10` |

收尾时远端 `dev` 前进了一次，新增提交为 Android 文案资源迁移。已另建只读检出核对：两提交的 `oai-core/` tree 均为 `cbd39c00de0a696136d8f73f6c9e5a25e404a310`；内置 DSH Adapter tree 均为 `155457d23f5761c5b025c434de365eed70f1b688`；`AgentSessionClient.kt` blob 均为 `3f06b50a1c1f535c2c65fa75152e0ef56edba498`。另外逐行核对了 12 处 Android 发送、身份、恢复、取消和去重片段，相关行为未变。本报告的 Android 行号按最终提交修正。**没有把旧提交上执行的测试伪称为在新检出上重新执行。** 详见 [快照增量复核](evidence/2026-11-11-dsh-core/latest-delta.md)。

后文 `DSH/` 表示独立仓库根目录，`OAI/` 表示 OAI 仓库根目录；宿主路径以已安装 DSH 的 `node_modules/@deepseek-ai/` 为基准。源码位置均属于以上固定快照。

Android文件名在后文使用以下唯一对应路径，避免省略包路径导致定位含糊：

| 文件名 | OAI根目录下的完整相对路径 |
|---|---|
| AgentSessionClient.kt | `apps/android/gateway-client/src/main/kotlin/com/openandroidintelligence/gateway/agents/AgentSessionClient.kt` |
| CoreAgentConversationRepository.kt | `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/conversations/CoreAgentConversationRepository.kt` |
| GatewayRuntime.kt | `apps/android/app/src/main/kotlin/com/openandroidintelligence/mobile/GatewayRuntime.kt` |
| WorkbenchController.kt | `apps/android/conversation-ui/src/main/kotlin/com/openandroidintelligence/conversation/state/WorkbenchController.kt` |

宿主实际发行文件额外固定SHA-256：`dsh-api-session-controller/lib/index.js` 为 `4cf6c66e65cce865d270fa89405b96d048ffa62e493e4ffbd1a826be2207a4cd`；`lib/types/commands.js` 为 `22a873ee9b1d4ea78ae6327f265ff9d7e0383250ad017b1eb580765fdf6cbb1c`。它们是安装包文件指纹，不是上游Git提交。

### 关键调用链及协议核对

```text
Android AgentSessionClient / CoreAgentConversationRepository
  → OAI sessions.py（客户端认证、能力门禁、操作回执、SSE观察）
  → DshSessionAdapter → RemoteSessionAdapter（桥Bearer、HTTP/NDJSON）
  → DSH createSessionHandler（HMAC握手、原生会话投影、prompt观察）
  → 真实 sessionQuery / SessionController / SessionCommandController
  → DSH 原生会话持久层、inbox 和 Agent turn

Android设备能力：Core CLI/MCP/API → Core设备授权/调度 → Android
```

| 契约 | 当前实现核对 | 结论 |
|---|---|---|
| Bundle 加载与注入 | 独立 `cordis.patch.yml` 插入 `oai-session-adapter`；`src/index.js:5-6,254-265` 注入 query、按需读取 controller，loopback 启动 HTTP | 独立真实加载通过；安装升级另有边界 |
| 发现与注册 | Core `configuration.py:1288-1324` 生成候选；`agent_registration.py:536-604` 实际调用 handshake 并验证身份/密钥 | 真实注册与读取通过；多 Profile 自动配置不足 |
| Bearer/HMAC | 独立 `src/index.js:65-69,171-188`；Core `agent_registration.py:167-193,274-300` | 挑战、实例、scope、online 和能力共同签名；无认证拒绝已测 |
| instanceId/sessionScope | 配置默认 `dsh`，可自定义；scope 固定 deployment，Core 校验一致性 | 符合共享部署会话架构；不是账号私有隔离 |
| 请求 Schema | 仅 text 的消息体、title 的创建体、value 的管理体；1MiB 边界；无 query、未知字段拒绝 | 基础兼容；新增身份字段须协商，不能直接强推给旧桥 |
| 健康与在线 | `GET /status` 实际调用 listSessions；online 依赖 list/history；Core 周期健康由 `agent_health.py` 管理 | 已测真实健康；不等于模型和所有写能力就绪 |
| NDJSON | 独立输出 delta/done/error；Core `remote.py:448-549` 有界逐行解析、终态检查、错误归因 | 基本格式兼容；独立缺身份、背压和可靠恢复 |
| 版本不一致 | 无独立 semver 握手门禁，按端点、HMAC 与能力降级；Core 能区分缺握手/认证失败/不可达 | 基础可降级，函数存在不能证明宿主方法签名兼容，见 AUD-007 |
| 宿主重启/热重载 | apply 的 dispose 关闭连接；重启重新读环境；Core 重新健康探测 | 独立重启回读通过；进行中生成恢复、热重载、轮换未验证 |

## B. 问题清单

分类约定：**已确认缺陷**表示调用链/契约确定有误；**已复现 Bug**另有本轮可重复证据；**潜在风险**说明后果尚未在完整环境实测；**功能缺失**说明没有通路或明确不支持。测试通过复现断言不表示产品正常。

### AUD-001 · P1 · 取消不匹配目标生成轮次，且回执不符合当前客户端

- **分类/归属**：已确认并复现；独立插件，实际宿主取消原语不能提供所声明的安全语义。
- **位置**：`DSH/src/index.js:81,233-246`；`OAI/oai-core/src/oai_core/sessions.py:1204-1211,1234-1242`；`adapters/remote.py:550-565`；Android `gateway-client/.../agents/AgentSessionClient.kt:161-172`。
- **触发/复现**：轮次 A 结束后同会话开始 B，延迟发送 `{value:{generationId:"old-generation"}}` 到 `/sessions/:id/cancel`。隔离处理器收到 200，宿主仅收到 `{sessionId}`。再直接调用真实宿主 `SessionCommandController.cancel`，携带旧轮次仍调用当前 Agent 的 cancel。
- **实际与预期**：实际忽略 generationId；返回 `{id,action}`，缺少客户端要求的相同 generationId 与 `cancelled/already_completed` outcome。预期仅原子取消指定轮次，过期请求不得影响新任务，并能证明取消对象。
- **根因/影响**：仅检测宿主存在 cancel 方法就声明能力；宿主方法只按会话取消当前 Agent。可误停终端或 App 的新任务。Android 正常停止路径还缺宿主 generation ID，不能因 cancel:true 声称按钮完整可用。
- **修复建议**：先关闭 cancel 声明。只有宿主支持原子比较轮次后才重开；单独“先查再取消”仍有竞态，不能根治。内置 `index.js:133-136` 已作安全降级。
- **验证要求**：A/B 竞争、过期/重复/空目标取消；非目标任务零副作用，回执与目标严格一致。
- **证据**：[消息复现及真实宿主方法测试](evidence/2026-11-11-dsh-core/message/repro.mjs)，测试“过期generationId…”及“真实安装DSH取消原语…”。没有在真实用户任务上执行取消。

### AUD-002 · P1 · 受理回执挂起后，断连、超时或已完成均不能释放 Busy

- **分类/归属**：已确认并复现；独立插件。
- **位置/函数**：`DSH/src/index.js:107-165` 的 stream，重点 `148-156`；内置对照 `index.js:270-318`。
- **触发/复现**：让 `controller.prompt()` 回执 Promise 一直不返回；分别断开观察连接、触发观察期限、提前发出原生 turn/end。测试把唯一的 30 分钟定时器压到 15ms；未改生产代码。
- **实际**：断连后仍有 2 个宿主监听器，处理器不退出；下一次同会话发送 `409 SESSION_BUSY`。超时时虽写出 `AGENT_TIMEOUT`，响应和 Busy 仍保留；done 先于受理回执时也不结束。
- **预期**：观察生命周期独立结束并释放本地资源；受理事实未确定时明确结果未知，晚到回执被安全消费。
- **根因/影响**：先 await prompt，随后才 await finishedPromise；close/计时器只能解析后者，finally 永远无法运行。可使一个会话永久不可再发，并保留响应和监听闭包。
- **修复建议**：分离受理与观察期限，使用可解除的回调槽，所有结束分支统一清理；异常/超时不能证明未执行，不应鼓励重发。内置可靠性实现可作参考，但必须同时修正 AUD-007 的真实宿主调用参数。
- **验证要求**：断连/超时/终态先到后，监听器归零、Busy 释放；晚受理、晚拒绝不得影响新观察。
- **证据**：消息复现中的三项挂起测试。已受理任务被“断观察就取消”**没有被证实**；本机真实 prompt 仅在入口检查 signal，见后文反例。

### AUD-003 · P2 · 客户端提交与原生消息身份链断裂，影响历史合并和未知结果处理

- **分类/归属**：桥字段丢失已确认并复现；Android 重复/占位残留后果为源码推导，未作真机复现。主要是独立插件；历史 rpcId 缺失两版共有。
- **位置**：`DSH/src/index.js:16-19,112,132-137,219-230`；Core `remote.py:232-235,373-374`；Android `CoreAgentConversationRepository.kt:1334-1337,1420-1446,1937-1946`、`GatewayRuntime.kt:2915`；`conversation-ui/.../state/WorkbenchController.kt:5705-5708,5754-5760`。
- **触发/复现**：对同一正文提交两次，独立插件生成两个不同 requestId；显式携带 clientMessageId 被 400 拒绝；即使合成原生事件有真实 user/assistant ID，done 仍只有 text；历史丢弃 `source.rpcId`。
- **实际与预期**：App 先用 client ID/stream 占位 ID，随后权威历史是另一组原生 ID，无法用来源关联；当前客户端明确禁止用正文/时间猜测合并。预期提交、原生 rpcId、用户消息与回复 ID 保持可核验关联。
- **根因/影响**：随机桥 requestId、不声明/支持 clientMessageIdentity、不回传原生消息 ID。Core **正常协商会省略 clientMessageId，故不能写成“所有当前 Core 发送都会 400”**。Core 操作回执可挡住同 operation 的重复，但不能补齐丢失的宿主身份；Core 状态丢失或改用新 operation 后的重试仍有重复执行风险。
- **宿主事实**：本机 DSH `SessionCommandController.prompt` 已按 inbox/历史 rpcId 去重；真实方法测试验证同 rpcId 提前 accepted。独立随机 ID 无法利用它，但不能仅凭这一测试承诺跨重启 exactly-once。
- **修复建议**：协商并透传稳定 clientMessageId，记录真实原生 userMessageId/messageId，历史保留来源关联；严禁按文字猜测或伪造 ID。内置修复了在线终态关联，历史仍需补齐。
- **验证要求**：同 ID 重试一次入队；同正文不同 ID 保持两条；实时转历史不重复；重启/未知结果按原 ID 查既有消息而不重发。
- **证据**：消息复现前三项及真实宿主去重方法测试；[客户端调用链](evidence/2026-11-11-dsh-core/core-client-findings.md)。

### AUD-004 · P2 · 慢消费者没有背压处理与观察缓冲上限

- **分类/归属**：无界写入路径已确认并复现；独立插件。进程 OOM 是潜在后果，本轮未耗尽真实内存。
- **位置**：`DSH/src/index.js:118-120,140-145`；内置对照 `index.js:13-15,174-200,256-266,303-305`。
- **触发/复现**：让响应第一次 write 即返回 false，再产生 2000 个 1KiB delta。插件仍调用全部 write，没有等待 drain 或切断观察；合成待写量约 2MiB。
- **实际与预期**：实际忽略 Node 写缓冲已满信号；预期限制观察队列的帧数/字节，等待可写，超过期限只停止观察。
- **根因/影响**：在同步宿主事件回调直接 res.write。Core 变慢、链路拥塞和多个慢观察者可持续增加 DSH 进程内存；Core 自己的帧限制不能替代插件出站缓冲控制。
- **修复建议**：有界队列、drain 与期限、统一清理；保留宿主任务独立运行。内置已有 128 帧/1MiB 等控制，可复用经验证的逻辑。
- **验证要求**：突发、永久/恢复 drain、多会话一慢一快、终态和断连，测资源上限与清理。
- **证据**：消息复现“慢消费者…”；双会话事件隔离测试通过，但没有把它等同真实网络压力或长时间内存稳定性。

### AUD-005 · P2 · 一个长会话可使整个会话列表 503，两版共有

- **分类/归属**：已确认并复现；独立插件与内置版本共有。
- **位置/函数**：独立 `src/index.js:95-100,198` 的 summary；内置 `index.js:150-155,363`。
- **触发/复现**：query 合法返回 150000 个合成事件，调用 GET /sessions。
- **实际与预期**：实际 `Math.max(...events.map(...))` 超过 JS 函数参数数量限制，抛 RangeError；整列表变成 `503 AGENT_UNAVAILABLE`。预期正常计算时间并保留所有其他会话。
- **根因/影响**：把每个事件展开成函数参数，外层又把实现错误泛化为宿主不可用。一个长期会话阻断整个部署会话发现；每次列表全量读全部历史也放大开销。
- **修复建议**：迭代求最大值，优先使用可靠的宿主摘要投影；按会话隔离错误且不得悄悄隐藏异常。
- **验证要求**：15 万及更多事件、多个正常/超长会话并存、耗时与峰值内存；不能用直接同步内置解决此项。
- **证据**：消息复现“长会话列表摘要…”。本轮未制造超长真实持久会话。

### AUD-006 · P1 · 安装后重启没有绑定所选 DSH Home / Profile

- **分类/归属**：已确认并隔离复现；**OAI Core 安装管理**，不是独立插件的会话桥职责。
- **位置/函数**：`OAI/oai-core/src/oai_core/configuration.py:1484,1499-1505,1526-1535,1613-1615,1670-1684,1704-1706,2036-2040` 的 restart_dsh_service_if_active；`scripts_runtime.py:842-843`。
- **触发/复现**：发现两个 Home，显式传入 target-home/worker，Mock systemd 表示 dsh.service active，调用真实重启函数。**没有执行真实 systemctl、SIGTERM 或停止宿主任务。**
- **实际与预期**：实际请求 `systemctl --user restart dsh.service`，完全未包含或核验所选 Home/Profile。预期仅重启经确认属于所选目标的服务，无法映射则明确不自动重启。
- **根因/影响**：固定服务名取首个 active；fallback 以 dsh+web 模糊匹配其他进程；部分调用方还丢弃已选 Profile。可中断其他实例的任务，而目标继续使用旧 Bundle。误注册非目标实例是配置组合下的潜在风险，未在真实多进程环境验证。
- **修复建议**：升级结果携带 home/profile/endpoint/服务身份至重启、注册全链；核验 WorkingDirectory、环境和启动命令，保留自定义参数；禁止模糊扫描后停止无关进程。
- **验证要求**：两个独立 Home/Profile，只升级其中一个；另一个 PID/turn 不变；所选目标恢复原启动参数，并以正确 instanceId/端口验握手。
- **证据**：[最小复现](evidence/2026-11-11-dsh-core/install/probe_restart_profile.py) 与同目录日志；[安装安全分项](evidence/2026-11-11-dsh-core/install-findings.md)。

### AUD-007 · P1 · 内置对照版本省略真实宿主 prompt 必需的 AbortSignal

- **分类/归属**：真实方法签名冲突和真实宿主失败路径均已复现；**OAI 内置 DSH Adapter**。独立版本传入 signal，不存在这一缺陷。
- **位置**：`OAI/integrations/dsh-session-adapter/index.js:287-289`；实际宿主 `dsh-api-session-controller/lib/index.js:4048-4060` 的 `SessionController.prompt(request, signal)`。
- **触发/复现**：用相同隔离 DSH 版本、配置和 Core DshSessionAdapter，分别加载独立与内置源码。内置发送只返回 `error/OUTCOME_UNKNOWN`，新建会话历史仍 0；独立发送进入宿主原生处理，因没有测试模型凭据返回 `AGENT_FAILED`，历史已有合成事件。再直接调用真实 SessionController.prototype.prompt，省略 signal 时入口 `signal.throwIfAborted()` 抛 TypeError。
- **实际与预期**：实际内置还未入队就异常，错误被 observeAdmission 的拒绝分支泛化为未知结果。预期提供不隶属观察 socket 的有效宿主 signal，同时保留受理和观察分离。
- **根因/影响**：为了不让观察连接拥有宿主任务取消权，直接删除参数，却未验证实际宿主 API 签名；Mock prompt 不要求 signal，使 89 项内置测试未发现此问题。Core 的正常状态与 send:true 不能说明真实发送可用。
- **修复建议**：按已验证宿主签名提供独立生命周期信号，或使用官方更明确的受理 API；保留观察者独立性。增加真实宿主契约测试，必要时明确支持的宿主版本范围。
- **验证要求**：真实 Cordis 注入路径可入队、真实模型回复；观察连接断开不取消已受理任务；受理悬挂仍按期限清理。
- **证据**：[内置真实宿主结果](evidence/2026-11-11-dsh-core/protocol/real-host-builtin-results.json)、[独立真实宿主结果](evidence/2026-11-11-dsh-core/protocol/real-host-standalone-results.json) 和消息复现的真实方法签名测试。上述没有模型凭据，**未宣称完成生成成功 E2E**。

### AUD-008 · P2 · 活动生成查询缺失，断线/Busy 后客户端队列恢复没有完整通路

- **分类/归属**：路由缺失已确认并复现；**两版桥接恢复能力缺失，以及 Core/Android 能力门禁衔接问题**。不是独立特有回归。
- **位置**：两版仅有现行 sessions/history/messages 等路由；Core `remote.py:292-301`、`sessions.py:874-879`；Android `CoreAgentConversationRepository.kt:1724-1739` 的 retryPendingDeliveriesFor。
- **触发/复现**：online=true、send=true 时经真实 DshSessionAdapter 调 current_generation；独立 HTTP handler 返回 `404 NOT_FOUND`。Android 在有待发队列、无本地轮次的恢复路径无条件查此接口，失败则建立 queueUnknownBarriers 并返回。
- **实际与预期**：普通同连接完成后可正常 drain，不应说所有 Queue 都坏；但重连/Busy 后恢复无法知道宿主是否仍在执行。预期只基于权威活动/终态证据安全恢复，能力不足要明确呈现未知状态。
- **根因/影响**：send 能力被用作 current-generation 路由的前置条件，桥却没有该路由和持久生成事实。队列可能长期保留，无法确认前一发送结果，人工重发有重复风险。Android UI 后果尚未真机验证。
- **修复建议**：明确只读活动生成查询与 generationRecovery 的分别能力；宿主有权威 turn 数据时桥接，Core/客户端同步门禁和降级交互；不能以空 generation、吞404或无条件重发冒充恢复。
- **验证要求**：排队后断线/Core重启/宿主重启；运行中不误投递，完成后同一消息各投一次；未知结果可用原身份查询。
- **证据**：[Core与真实插件处理器探针](evidence/2026-11-11-dsh-core/core/generation-route-probe.py)（query 为合成宿主），输出 online/send=true 与 NOT_FOUND/404；客户端后果来自当前源码。

## C. 功能覆盖矩阵与实现漂移

状态限定：**通过**均写明本轮验证层级；**有 Bug**对应上述编号；**未验证**表示虽存在实现但缺所需运行证据；**不支持**表示能力关闭或没有通路；**Core负责**不计作插件缺陷。

| 功能 | 独立 DSH 插件 | OAI 内置版本 | Core 接口/责任 | Android 实际通路与本轮状态 |
|---|---|---|---|---|
| 加载、注册、握手、健康 | 真实宿主与 Core 库集成通过 | 相同基础集成通过 | 身份库注册、HMAC、健康 | 支持描述符；完整 App 登录未验证 |
| 会话列表 | 实时 query；超长列表有 Bug 005 | 同病 | GET sessions | 能拉取；真实发现/创建回读通过 |
| 终端已有/新建会话发现 | 每次重新 listSessions | 同 | 不替代宿主 corpus | 合成新增发现测试通过；真实终端 UI 操作未验证 |
| App 创建会话 | controller.create | 同 | POST sessions、操作回执 | 真实 Core 库创建及宿主持久回读通过；App界面未验证 |
| 历史文字/顺序/原生 ID | 保留事件顺序及 message.id；身份缺陷003 | 同，历史仍缺 rpcId | GET history | 权威ID合并；合成历史通过，真实合成失败历史可读 |
| 重命名 | 已实现，真实回读通过 | 相同基础验证通过 | PATCH rename | 按能力显示；App操作未验证 |
| 归档/取消归档 | 明确不支持，cap=false | 同 | 有路由但能力门禁 | 不能把死分支算实现；不支持 |
| 删除原生会话 | 明确不支持，cap=false | 同 | DELETE 路由能力门禁 | 不支持 |
| 文字消息 | 已实现但有Bug002/003 | 在本机宿主有Bug007 | POST messages、SSE与操作ledger | 实际模型成功未验证 |
| 图片/文件发送 | 不支持；只接受text、无上传桥 | 同 | 有附件属主校验与上传能力门禁 | DSH能力关闭；不是Core本身不支持附件 |
| 原生图片/文件历史回读 | 不支持；textOf丢非文字部分 | 同 | 可代理桥附件metadata/content | App不能完整呈现DSH非文字历史；桥功能缺失 |
| 文字流增量 | 隔离契约通过；有Bug004 | 隔离测试有界队列/心跳通过；实际send有007 | NDJSON→SSE、8MiB帧限制 | 解码支持；真实模型流未验证 |
| 完成/失败终态 | 合成done/error通过；真实无凭据失败返回AGENT_FAILED | 合成终态通过；本机实际受理前OUTCOME_UNKNOWN | 终态、操作状态和错误来源 | 可解析，独立终态缺原生消息身份 |
| 精确停止/取消 | 错误声明，有Bug001 | 明确关闭以防误取消 | 目标generationId与回执契约 | 当前无法完整安全停止DSH任务 |
| 观察连接断开 | 正常受理后可清理；悬挂有Bug002 | 隔离观察实现，但需修007 | Core生产者与App观察者分离 | Core保护不能代替桥端验证 |
| 流重连/生成恢复 | 不支持持久generation查询 | 明确generationRecovery=false | 路由可代理；能力衔接有008 | 重连队列路径缺完整通路 |
| 消息身份/未知结果重试 | 有Bug003 | 在线终态身份较完整；历史仍有缺口 | operationRecovery≠宿主generationRecovery | 不能盲重发；实时/历史关联不足 |
| 多次发送/队列 | 同会话观察busy，原生mode=queue | 同，清理更完善但有007 | Core生产者/回执；宿主inbox | 普通完成可drain，断线恢复有008 |
| 多会话并发隔离 | 本轮双会话合成并发通过 | 既有相关测试通过 | Agent/session组合路由 | 没有真实多账号多Profile压力验证 |
| `/new` | 没有原生命令通路 | 同 | 创建会话API存在 | App新建走create；不支持终端命令形式 |
| 模型切换、DSH命令 | 不支持commands，无catalog/执行路由 | 同 | 有命令API与门禁 | `/model`按普通文字发送不能算切换成功 |
| 工具调用/结果显示 | 不映射结构化工具事件 | 同 | Core/Android有executionSteps数据通路 | 宿主执行工具≠App可视化；桥功能缺失 |
| 宿主审批请求/决策 | 不支持approvals，无事件/决策路由 | 同 | 有审批卡片及决策API | 需要终端介入；不能由桥伪造审批 |
| 双向列表/历史刷新 | 主动拉取已实现 | 同 | GET会话/历史 | 真实创建和重启回读通过；App/终端双界面未验证 |
| 持续事件同步/ACK | 不支持eventSync | 同 | 有events/ack协议 | 不能声称后台持续同步已支持 |
| Android设备CLI/MCP/API | **应由Core负责** | 同 | device_service/cli/mcp认证、授权、路由 | Android执行和本地授权；本轮未调用真实设备 |
| 安装/旧Bundle升级 | Bundle可加载；Core安装路径隔离测试通过 | 安装器去重旧新Bundle | Core安装管理/宿主包管理 | 真实包安装/升级未执行，不能标整体通过 |
| 更新、配置、Token管理 | 捕获进程桥Token；需正确重载环境 | 增加reloadToken尝试 | 生成私有密钥/配置同步/显式迁移 | 无缝轮换、原地更新后恢复未验证 |
| 卸载、诊断 | 使用官方Bundle管理；缺内置追踪实现 | 有diagnostics，安装错误分类较完整 | Core管理/官方plugin工具 | 真实卸载未执行，不要求桥另建卸载系统 |
| 多Profile同时自动接入 | Config支持自定义端口/实例/环境名 | 同 | 当前自动发现只产固定dsh/8791候选 | 自动多实例配置不足；重启目标另有006，手动多实例未验证 |

### 差异逐项归因

| 差异 | 类别及行为后果 |
|---|---|
| 独立main新增handshake | **已完成修复**；真实Core验证通过，不能继续报告历史404 |
| 内置clientMessageIdentity与终态原生ID | **兼容性修复/能力增强**；独立缺失导致003，不等于宿主幂等已完成 |
| 内置受理/观察期限与解除回调 | **可靠性修复**；独立存在002 |
| 内置有界队列、drain、心跳 | **可靠性增强/修复**；独立存在004。缺心跳本身不直接等于当前Core一定60秒断开，Core仅在协商streamHeartbeat后启用该空闲预算 |
| 内置cancel=false | **安全修复**；独立保留危险声明，见001 |
| 内置generationRecovery/idempotentSend=false | **诚实能力降级**；不能把关闭声明误认成功能回退Bug；底层恢复通路仍缺008 |
| 内置不再传prompt signal | **反向API漂移/回归**；本机真实宿主不能受理，见007 |
| 内置diagnostics/trace | **可观测性新增**；独立缺少细分trace，不能因此单独认定业务执行失败 |
| 内置Token重新加载尝试 | **架构/运维增强**；独立需重载。内置优先读进程环境，不能仅凭存在reloadToken宣称文件轮换无缝生效 |
| Bundle名不同、插件ID相同 | **拆仓/安装结构变化**；正常Core升级收敛activeBundles为一个新Bundle，并保留旧依赖。没有证实正常升级会重复加载 |
| 两版同样缺归档/删除/附件/命令/审批/事件同步 | **明确支持范围或桥功能缺失**；逐项在矩阵标注，不伪称已支持，不扩大设备权限职责 |
| 两版Math.max展开、历史rpcId丢失 | **共有缺陷/缺口**；同步内置不能修复005或完整解决003/008 |

### 安全、权限与部署边界

1. **设备授权与会话桥密钥隔离符合当前架构。** 独立桥只收内部Bearer并监听127.0.0.1；没有Android配对或设备授权逻辑。Core的 `test_dsh.py` 验证共享发现与不透传设备授权身份；诊断trace不等于账号凭据。不能把设备工具入口不在桥中算插件缺失。
2. **deployment共享会话是显式契约。** `OAI/oai-core/src/oai_core/adapters/dsh.py:1-5,16-25` 与握手均明确共享原生corpus，不向DSH发送OAI account ID。两个已认证用户看到同部署会话本身不构成已证实越权；互不信任用户须配置不同受控DSH实例/范围。
3. **Token生成和读取有真实防护。** Core `agent_registration.py:94-163` 用随机私有0600文件、拒绝不安全权限和最终符号链接、不覆盖现有密钥；`configuration.py:2604-2681` 负责dotenv/credentials同步。未打开实际凭据文件。本轮只验证合成桥密钥。
4. **请求校验先于执行。** Bearer、challenge、未知字段、请求体预算、未知会话等已有隔离测试。sessionId经解码后仍需命中宿主真实列表，不直接作为文件路径。本轮没有证实可绕过认证或借非法路径执行宿主任务。
5. **安装安全不能等同真实安装成功。** 安装器验证目标路径/属主/变更快照、使用官方锁和包管理API，失败备份并校验恢复。43个安装测试及69个Core安装配置测试通过。官方runProfilePnpm要求调用者已持锁，因此没有证据支持“这里必然重复加锁死锁”。真实首次安装、升级、卸载和故障回滚没有运行。
6. **Token轮换需完整重载链。** 独立handler捕获旧Token，修改磁盘配置不代表进程已加载；Core注册还绑定密钥摘要，已有身份/密钥变化要求显式迁移（`agent_registration.py:289-295`）。不得通过重建身份或无条件换密钥绕过。真实轮换、热重载和凭据失效窗口均未验证。
7. **没有证据证明受理后断观察会取消本机DSH任务。** 直接调用真实prompt方法验证入口后的abort仍accepted；它只在入口检查signal。观察与受理应分离，但不能把此设计建议写成本轮已复现的取消Bug。

## D. 测试证据

### 既有自动化验证

以下既有测试命令的OAI部分在测试快照 `d5b82cb...` 执行；相关Core与内置Adapter源码经Git tree比较与最终 `2417284...` 完全相同。归档后的活动生成探针与两版真实宿主探针又在最终检出 `2417284...` 运行，结果一致，日志分别为 `generation-route-probe-final.txt`、`real-host-standalone-final.txt`、`real-host-builtin-final.txt`。测试使用现有依赖，没有全量Android编译、安装新工具链或阻塞轮询CI。

| 验证 | 实际命令/入口 | 通过 | 失败 | 跳过 | 证据 |
|---|---|---:|---:|---:|---|
| 独立插件全部测试 | 隔离源码快照内 `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism` | 20 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/standalone-tests.txt) |
| 独立类型检查 | 同目录 `node node_modules/typescript/bin/tsc --noEmit` | 1次检查 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/standalone-typecheck.txt)；checkJs=false，不能视作严格JS类型契约验证 |
| OAI内置DSH四个文件 | `./node_modules/.bin/vitest run --config integrations/dsh-session-adapter/vitest.config.js` | 89 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/builtin-tests.txt) |
| Core会话/流/交互/操作恢复 | `PYTHONPATH=oai-core/src python -m pytest -q` + 下列六个文件，`-p no:cacheprovider` | 89 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/core/pytest-core.txt) |
| Core安装配置 | `PYTHONPATH=oai-core/src python -m pytest -q oai-core/tests/test_dsh_installation.py oai-core/tests/test_dsh_setup.py --basetemp=<新隔离目录> -p no:cacheprovider` | 69 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/install/install-python-tests.txt) |
| 握手错误/健康/发现隔离 | `PYTHONPATH=oai-core/src .venv/bin/python -m pytest -q oai-core/tests/test_agent_handshake_errors.py oai-core/tests/test_agent_health_recovery.py oai-core/tests/test_agent_discovery_failure_isolation.py --basetemp=<新隔离目录> -p no:cacheprovider` | 27 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/core-handshake-health-tests.txt) |
| 安装器独立复核 | 隔离复制内置 `install.test.js` 后使用Vitest执行 | 43 | 0 | 0 | [日志](evidence/2026-11-11-dsh-core/install/install-node-tests.txt)；已包含在上面89中，不重复计数 |
| 独立上游漂移检查 | `OAI_UPSTREAM_ROOT=<OAI检出> npm run verify:upstream` | 0 | 1次检查 | 0 | [日志](evidence/2026-11-11-dsh-core/upstream-drift.txt)；源码、测试、patch三项不一致，不等同三个业务Bug |

Core六个聚焦文件：`test_dsh.py`、`test_remote_stream_frames.py`、`test_remote_stream_phases.py`、`test_remote_generation.py`、`test_native_interactions_core.py`、`test_native_operation_recovery.py`，均位于 `oai-core/tests/`。

既有单元/契约测试去重合计 **294 passed、0 failed、0 skipped**。上游漂移检查另计为预期可解释的失败。独立仓库现有 `.bin` 包装器不能在本机执行，直接npm test/typecheck初次报 Exec format error；改用同一已安装包的JS入口后成功。OAI安装依赖的Vitest `4.1.10` 与manifest当前写的 `4.1.11` 不同，报告保留实际运行版本，没有做全新npm ci或声称锁文件安装验证通过。

### 最小风险复现

| 探针 | 结果 | 关键输出与范围 |
|---|---|---|
| [消息复现](evidence/2026-11-11-dsh-core/message/repro.mjs) | **13通过、0失败、0跳过** | 身份字段丢失；挂起断连/期限/终态三场景；2000 delta背压；过期取消；15万事件；真实宿主signal、cancel、rpcId去重方法；双会话隔离 |
| [Profile重启复现](evidence/2026-11-11-dsh-core/install/probe_restart_profile.py) | **1个复现断言通过** | 显式target-home/worker仍请求restart dsh.service；systemctl完全Mock |
| [活动生成路由](evidence/2026-11-11-dsh-core/core/generation-route-probe.py) | **1通过** | `{online:true,send:true,currentGeneration:"NOT_FOUND",httpStatus:404}`；真实桥处理器+真实Core传输，宿主query合成 |

这15项复现断言不与“功能验证通过”混算。消息并发测试中两个会话使用turn7/19并故意共用attemptId，增量/终态未串流，错误turn终态被忽略，监听器4→2→0；证明所测隔离路径正常，不能替代真实多Profile压力验证。

可在独立仓库运行消息复现：

```bash
node --test docs/reviews/evidence/2026-11-11-dsh-core/message/repro.mjs
```

真实宿主方法测试要求PATH中存在 `dsh`，按该CLI自己的依赖树解析模块，不读取用户配置。其余Python探针从OAI仓库执行，例如：

```bash
PYTHONPATH=oai-core/src python ../dsh-android-gateway/docs/reviews/evidence/2026-11-11-dsh-core/install/probe_restart_profile.py
PYTHONPATH=oai-core/src python ../dsh-android-gateway/docs/reviews/evidence/2026-11-11-dsh-core/core/generation-route-probe.py
```

每次pytest的basetemp使用新目录并保留证据；不要将相同目录用于会触发清空的重跑。

### 真实宿主集成与E2E边界

[真实宿主探针](evidence/2026-11-11-dsh-core/protocol/real_host_probe.py)以全新DSH_HOME启动真实CLI，仅传入合成桥Token、PATH等白名单环境，不继承模型凭据；`--no-open`关闭浏览器自动打开。每次结束均关闭本轮子进程，保留隔离数据供复核。只归档脱敏结果，不归档数据库、密钥、凭据或原始宿主带访问Token的启动日志。

| 链路步骤 | 独立插件结果 | 内置对照结果 |
|---|---|---|
| DSH启动、插件加载及真实服务注入 | 通过 | 通过 |
| 当前Core HMAC握手/签名 | 通过 | 通过 |
| 临时真实IdentityStore管理授权、注册与条目回读 | 通过 | 通过 |
| Core真实DshSessionAdapter健康/列表 | 通过 | 通过 |
| 创建、空历史、重命名、列表回读 | 通过 | 通过 |
| 无Bearer拒绝 | 401，通过 | 401，通过 |
| 提交合成文字，无模型凭据 | 进入原生处理并返回AGENT_FAILED；历史行数5 | 返回OUTCOME_UNKNOWN；历史0，符合AUD-007 |
| 停止并重新启动宿主，持久会话回读 | 通过 | 通过 |
| 真实模型生成回复、成功delta/done及完整回复历史 | **未验证/缺独立测试模型配置** | **未验证，且先受AUD-007阻断** |
| 完整Core HTTP服务、App登录与双界面交互 | **未验证** | **未验证** |
| Android真实设备能力CLI/MCP/API | **未验证/没有隔离配对设备链路** | 同 |
| 真实生成中断网、Core重启、宿主重启、热重载、Token轮换 | **未验证**；相关边界用隔离契约/方法探针覆盖部分 | 同 |
| 实际首次安装、旧Bundle升级与卸载 | **未验证**；只验证加载及安装器隔离行为 | 同 |

可从OAI检出重跑真实宿主探针（所有操作仍仅写全新隔离目录，不指向既有DSH_HOME）：

```bash
PYTHONPATH=oai-core/src python ../dsh-android-gateway/docs/reviews/evidence/2026-11-11-dsh-core/protocol/real_host_probe.py --adapter ../dsh-android-gateway/src/index.js --label standalone
PYTHONPATH=oai-core/src python ../dsh-android-gateway/docs/reviews/evidence/2026-11-11-dsh-core/protocol/real_host_probe.py --adapter integrations/dsh-session-adapter/index.js --label builtin
```

这些是**真实宿主与Core库集成证据**，不是“Android→完整Core服务→DSH→真实模型→回复”的成功E2E；也没有用Mock回复冒充真实模型。

独立审校已核对8项问题的源码、复现边界、能力责任和去重计数，未发现需要撤回或调整结论的事项，详见 [独立复核记录](evidence/2026-11-11-dsh-core/independent-review.md)。

## E. 修复优先级与后续验收

| 优先级 | 事项 | 依赖与验收 |
|---|---|---|
| P0 | 本轮未确认P0 | 不据此声明安全审计完全无漏洞 |
| P1，必须立即修复 | AUD-001关闭危险cancel；AUD-002受理/观察分离 | 第一项须先安全降级，随后再谈轮次恢复；第二项不能把unknown写成确定失败 |
| P1，必须立即修复 | AUD-006安装重启绑定所选实例 | 独立于消息开发，必须防止干扰其他Profile；禁止用真实任务测试错误停止 |
| P1，必须立即修复 | AUD-007内置prompt参数与实际宿主契约 | 是吸收内置可靠性实现前的前置修复；不能整文件盲同步 |
| P2，发布前补齐 | AUD-003稳定提交/原生消息身份 | 是未知结果、历史合并和未来恢复的基础；先建立真实来源身份 |
| P2，发布前补齐 | AUD-004有界观察缓冲、AUD-005长历史摘要 | 复用现有可靠性实现并修正共有缺陷；验证资源上限及其他会话不受牵连 |
| P2，发布前明确闭环 | AUD-008活动生成/队列恢复 | 依赖003及宿主权威生成事实；Core、桥、Android同步门禁和未知状态交互。若暂不实现，须明确限制产品支持范围，不能承诺可靠重连 |
| P2/P3，按产品承诺纳入 | 附件输入/历史回读、审批与工具事件、命令/模型切换 | 归桥协议适配与Core/Android既有接口衔接，不复制账号或设备授权；若产品宣称这些能力则发布前补齐，否则明确不支持 |
| P3，后续增强 | 持续事件同步、完整多Profile自动部署、追踪诊断、无缝Token轮换 | 保留既有会话/配置与回滚证据；明确实例身份、环境、端口后再自动化 |

修复后开发Agent应先固定宿主支持版本和三个仓库接口事实，逐项增加上述复现对应的回归断言，再使用**专用模型配置、专用DSH_HOME、专用Core身份与隔离Android设备**完成成功E2E、断网/进程重启/未知结果/取消竞态。发布门槛至少包括：所有P1关闭、消息可按真实ID关联、慢观察者有界、长历史正常、恢复状态有权威证据、未支持能力不误声明、更新不影响其他Profile且不替换原生数据。本轮没有执行这些生产修复，也没有替代用户作发布或合并决策。
