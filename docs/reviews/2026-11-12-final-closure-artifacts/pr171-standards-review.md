# PR #171 独立 Standards 审查

固定基线：`02ad53e09049c2b06c21cacd9d009c2f14e6d5bd`；固定头：`b524835634a348f9b94fa0b1119ea52db38ee8e9`。实际审查命令为 `git diff 02ad53e09049c2b06c21cacd9d009c2f14e6d5bd...b524835634a348f9b94fa0b1119ea52db38ee8e9`，其共同祖先等于基线，共 9 个变更文件。

## 硬违规

未发现需要阻止合并的已证实规范违规。

- 依据 `AGENTS.md`，新增注释、诊断文档、提交说明均使用中文；新增持久文件位于 `docs/reviews/`。代码与文档没有硬编码个人工作区路径，也没有永久删除命令。生成目录已被现有 `/tmp/` 忽略规则覆盖。
- `HermesHttpInteropTest.kt:48–54` 为每个夹具实例创建独立文件；四处启动均使用该入口。原 HTTP/SSE 回复、批次重放、两次执行断言保留，`360–372` 额外检查会话与消息身份，没有放宽测试。
- `reproduce.py:65–81` 启动固定外仓的真实 `--echo-agent` 进程并等待本机 HTTP 地址，同时强制 `OAI_REQUIRE_NATIVE_HERMES=1`。代码具有构建与第二夹具的 `finally` 清理路径。归档红测确为目标计数断言失败，绿测与两变体各 5 个用例输出一致。
- 文档 `17、61` 行明确限制受控复现、Full、部署及实体设备之间的证据范围，没有把可解释机制宣称为原 CI 的精确调度证明。

## 建议

- 非阻断的退出健壮性建议：`reproduce.py:88–96` 对 `terminate()` 仅等待十秒；若等待超时，将直接抛异常，第二夹具清理超时还会跳过 `os.close(fd)`。可在后续增强超时分支的收尾，保证观察句柄关闭，并明确报告仍存活的进程。固定夹具正常处理 SIGTERM，当前没有发现或复现遗留进程；这不是本轮已证实硬违规。
- 对命名不明、重复、Data Clumps、Primitive Obsession、Feature Envy、Message Chains、Middle Man、Speculative Generality 等启发项检查后，没有足够具体、收益明确的新增发现。

## 证据限制

实际执行：固定差异 `git diff --check`、重放脚本 `py_compile`、6 个文档相对链接存在性检查，均通过。未重新运行 Gradle、Full 或设备验证；红绿与回归结果仅核对本 PR 归档输出，未当作本轮独立执行。

`docs/agents/issue-tracker.md` 缺失；已读取实时 PR #171 与 issue #169 作为需求来源。该文件缺失属于审查基础设施提示，不计代码缺陷；技能建议以后运行 `/setup-matt-pocock-skills` 补齐。

结论：硬违规 0 项；非阻断建议 1 项。
