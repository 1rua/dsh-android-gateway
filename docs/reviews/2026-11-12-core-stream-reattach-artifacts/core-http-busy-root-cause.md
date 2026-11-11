# Core观察断开后同身份重附被SESSION_BUSY拒绝

日期：2026-11-12，Asia/Shanghai。本记录区分真实模型失败与零模型受控根因复现；没有修改生产源码、部署或读取私人会话。

## 真实模型发现

独立桥固定未提交快照 `b5ed48fae300da3acfc2f5d651b286577af67724a9ec10580ed9959b87022c56`，Core HEAD为 `4bf09d5c98427eda5c3303d9722894d3fd32b08d`，两个工作区的dirty状态及全部运行模块摘要记录在[结果](real-model-failure-summary.json)。

真实官方DSH和既有专用测试模型经完整Core HTTP/SSE首次发送：0.103秒收到原生generation身份，测试客户端立即关闭观察，GET确认原任务仍running。随后以同一个clientMessageId和另一Core操作键重附，0.237秒只收到error帧。原生任务继续完成，持久回复899字且原生ID一致，没有工具或模型重试；失败记录保留，之后两项输入和内置模型测试未执行。已启动的隔离进程全部退出、模型密钥未落盘。

该轮脚本原先仅记录帧type，不能单独证明错误码。脚本现已补充脱敏`type/code/retryable`记录；以下零模型反馈环独立确证具体代码和处理器关系，没有重跑真实模型来猜测。

## 可执行根因反馈环

[core-http-busy-probe.py](core-http-busy-probe.py) 启动真实`create_core/create_app`、真实注册/登录与原样导入的`createSessionHandler`，仅宿主事件由受控夹具提供；无模型请求，不属于真实DSH或模型E2E。夹具在用户消息后保持运行，直到显式release才发真实格式的合成助手和turn/end。

独立桥复现结果：[JSON](controlled-busy-failure-summary.json)。首次SSE只收generation后关闭；此时桥的promptCount为1、running且仍有2个监听器。同clientMessageId第二观察得到`error/SESSION_BUSY`，promptCount仍1；手动发终态后原生generation completed，监听器0。Core同时出现与真实模型轮相同的`ClientConnectionResetError`类型日志。

对应命令，从仓库根执行：

```bash
python .worktrees/dsh-remediation-state/core-http-busy-probe.py \
  --core-root .worktrees/dsh-corpus-scaling \
  --adapter .worktrees/dsh-plugin-corpus-scaling/src/index.js
```

同脚本改为内置桥路径也复现，结果位于`core-http-busy-builtin-probe-console.txt`及其明确的JSON引用。该复现稳定无模型，不读取任何已有账号、密钥或会话。

## 确认根因与责任

Core `sessions.py` 的send有意将`produce()`注册为独立操作，HTTP观察finally只设置`observing=false`并清理输出队列。这样断观察不会取消宿主任务，且Core仍能持久完成操作回执；此设计本身符合任务要求。

两桥`stream()`在任何持久generation查询之前先执行`if (busy.has(id)) throw SESSION_BUSY; busy.add(id)`。该busy持续到旧桥观察的finally，代表观察寿命而不是原生提交互斥。Core客户端断开不会关闭Core→桥旧观察，第二个相同已接纳输入因此无法进入本来支持的运行中generation重附分支。

这不是宿主任务丢失或重复执行：原任务完成且原生输入仍唯一。确认缺陷是Core链路运行中流重附不可用，并将可恢复观察表现为失败。直接关闭桥HTTP后的既有25项重附通过无法覆盖Core仍持有旧观察这一窗口。

修复不得通过取消Core producer、取消宿主任务或无条件重发来绕过。应分离提交互斥和观察所有权，允许已权威确认的相同clientMessageId附着同一代次，同时保持尚未接纳时并发重复只提交一次、不同身份保持既有Busy/队列语义，以及每个观察独立释放、最后观察不取消任务。两仓应同步实现并测试。

## 需要补充的验证

- 原受控反馈环应从SESSION_BUSY转为同原生generation的运行中增量/终态，promptCount仍1。
- 同身份首次受理挂起与并发两个POST不能双prompt；不同身份不得串错代次。
- 多观察分别断开、慢消费者溢出/超时、末个观察释放不得取消宿主；监听器/Busy引用全部释放。
- 修复后重新运行完整Core HTTP真实模型验收，继续覆盖取消、旧目标、Core运行中重启、DSH/Core双重启与冷重放；失败先前结果不得覆盖或改写为通过。

归档结果使用字段白名单：只保留合成场景检查、布尔状态、耗时与稳定失败码；模型配置、账号、地址、随机会话ID、时间戳和凭据读取元数据均未推送。
