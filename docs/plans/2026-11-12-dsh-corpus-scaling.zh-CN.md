# DSH 大会话目录查询修复计划

日期：2026-11-12。问题：独立插件 #10 / OAI #148。

真实本机与全合成 305 个当前 v4 压缩会话均暴露列表拖慢健康检查。原实现对每条摘要分别执行 readTitle/readSurface，而两个宿主接口各自再次全库扫描；611 次扫描争用同一持久层并发队列。合成旧实现列表 20 秒超时，并发健康 5 秒超时，未认证 401 仍能快速返回。

修复应通过一次可取消会话列表与有界的官方精确观察构建完整摘要，复用公共 Session 准备与 surface/title 投影，保留全部会话、真实标题与原有更新时间语义。客户端断开、查询期限或错误必须停止未开始的工作并释放所有观察租约；不关闭能力，不伪造在线，不用陈旧缓存掩盖。旧宿主保留既有读取回退。

先补扫描放大、并发上限、surface replacement 时间、取消与租约释放的失败回归。修复后运行两侧原有 Node 回归、TypeScript 与漂移检查，再用 305 合成压缩会话和真实官方 DSH 验证完整列表、并发健康、断开后的恢复及无持久会话副作用。独立审查、正式服务部署与模拟器验收由主任务负责；本分支不部署。

当前状态：源码与回归已完成并推送，双侧独立审查无新增阻断缺陷；正式服务部署与完整Core恢复验收仍待主任务完成。


## 实施与验证证据

现代宿主通过一次可取消 `listSessions(signal)` 枚举，再用插件共享两个读取名额执行 `observeSession(id,{signal,projectionMode:"none"})`。使用官方 `sessions.prepare` 的未入表投影获取原 surface 节点，对最新 `session/title` 取官方相同字段；不新增依赖、不创建或写入真实会话。旧宿主保留原读取回退，旧 `readSurface` 本身无可取消接口的边界明确保留。

- 内置Node 133项、独立Node 90项、Core DSH相关102项通过；类型、10对漂移、差异空白检查通过。
- 真实官方DSH、305个合成v4压缩空日志：修复前列表20秒/并发健康5秒超时；最终内置列表800.01ms、并发健康190.71ms，完整305项。
- 两侧资源审计各8检查通过：一次持久层枚举、305个观察全部释放、观察并发最大2、原会话文件属性不变、store/created/event零新增；枚举期及观察期断开均释放，之后列表恢复。
- 原生replacement及继承seed与官方readSurface/readTitle逐字段相同，无额外种子事件。
- 独立双轴审查Standards0/Spec0；实际独立执行13项聚焦、10组漂移及双侧6项竞态探针，每桥44租约全部释放，无未处理拒绝。
- Fast原始运行在Gradle默认缓存只读锁失败，未记全绿；复用现有缓存补noVpnSurfaceCheck成功，该项命中UP-TO-DATE，保留真实执行边界。

[根因与证据](../reviews/2026-11-12-dsh-corpus-scaling-artifacts/corpus-scaling-root-cause.md)、[独立审查](../reviews/2026-11-12-dsh-corpus-scaling-artifacts/corpus-final-independent-review.md)、[资源结果](../reviews/2026-11-12-dsh-corpus-scaling-artifacts/corpus-resource-results.json)。这些证据均为合成数据，不含生产会话正文或实际凭据。

## 未完成与边界

本修复已消除当前v4会话的逐项全库扫描，尚不以305空正文结果外推到任意大正文、旧格式、第三方投影。多个请求各自的一次枚举没有跨请求合并。最新完整CoreHTTP验收另外发现运行中同身份重附被SESSION_BUSY拒绝（DSH12/OAI152），已另项修复；本PR不把列表性能恢复当作完整发布成功。部署、真实HMAC与最终Android回读由主任务单列完成。
