# 最终Full ColdStart失败的固定证据摘要

日期：2026-11-12。关联OAI #173。本摘要根据已完成的只读诊断与固定提交单方法输出整理，不是新一轮测试执行，也不替代完整Full。

## 原失败

run43129391533 attempt1固定head为83fbef075a494f0d4899cc22c08b4864c9edb3cd，FullRelease共1855测试、1失败、1跳过。`ColdStartConnectionTest.kt:197`在十秒内同时等待新SSE连接数增加及连接状态LIVE；日志没有两个条件各自终值，未到第201行独立耗时预算断言，不能仅凭失败位置推定具体阶段。

CI checkout5b79b11f443adb619722b610257defc235cf38fd与83fbef07完整树均为fee2a110a9d6dd2d359dbc6bae231d448b0f50b5，排除了误读不同源码的解释。

## 单项复跑与边界

相同83fbef07、同FullRelease原方法本地一次1/1通过，0失败/错误/跳过，恢复4012毫秒，JUnit方法8.191秒。Gradle总3分6秒含隔离源码初次Release编译；单方法没有复刻CI多模块/多变体资源竞争，不当作完整类、真实设备或Full通过。

尚未证实的候选包括：暂停写入后已在途完整心跳在前台采样后被消费；CI调度使检查/取消/重连超过预算；旧SSE退出或二次握手未及时完成。它们仍是可证伪假设，没有据此修改生产代码、放宽十秒预算或添加无条件重试。

attempt2在PlayDebug另一方法失败，FullRelease任务已执行且没有ColdStart失败行；不能写ColdStart再现。最新2caab Full仍待后台终态。Issue #173保持open。
