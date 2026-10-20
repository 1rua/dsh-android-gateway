# Agent 行为规范

## 回答规范

- 所有回答或注释必须使用中文。
- 从用户的角度解释当前进度，让用户清楚知道"现在在做什么"、"接下来要做什么"。
- 尽量使用通俗易懂的语言，避免过多使用技术术语。如果必须用到技术术语，需要附带简单的解释。

## 文件删除规范

- **严禁使用 `rm`、`rm -rf`、`unlink` 或其他任何永久性删除命令。**
- 若需要删除文件或目录，必须使用以下安全方式之一：
  - 安装并使用 `trash-cli`（`trash-put` 命令）将文件移入回收站。
  - 将文件移动至 `/tmp/<项目名>-trash/` 临时目录供用户人工复核，确认后再由用户手动清理。
  - 示例：`mv 文件路径 /tmp/open-android-intelligence-trash/`
- 此规则适用于所有环境，任何时候都不得绕过。

## 复杂任务处理规范

- 面对复杂任务时，优先阅读项目中相关的 Skill 文件，充分理解上下文后再动手。
- 将复杂任务拆分为多个子任务，创建多个子 Agent 并行处理，提高效率。
- 子 Agent 之间应职责清晰、互不阻塞，主 Agent 负责汇总和整合结果。


## 代码规范

### 1. 路径引用规范

- 代码中涉及文件引用、模块导入、依赖路径等，**一律使用相对路径**，不得使用绝对路径。
- 相对路径应以项目根目录或当前文件所在目录为基准，确保项目在不同环境下可移植、可复用。
- 示例：
  - 正确：`import { utils } from './utils'`、`require('../config/settings')`
  - 错误：`import { utils } from '/mnt/数据/项目/open-android-intelligence/src/utils'`

## Git 提交规范

- 所有 git 提交说明（commit message）必须使用中文撰写。
- 提交说明应简洁明了，清晰描述本次变更的内容。
- 提交说明格式建议：`<类型>: <简要描述>`
  - 类型示例：新增、修复、优化、重构、文档、清理 等

## Git 忽略规则

- 以下文件和目录必须加入 `.gitignore`，不得提交到仓库：
  - **构建产物**：`node_modules/`、`**/build/`、`*.apk`、`*.aab`、`dist/`、`.gradle/`
  - **IDE 配置**：`.idea/`、`.vscode/`、`*.swp`、`*.swo`
  - **环境变量与密钥**：`.env`、`.env.*`（允许 `.env.example`）、`*.tsnet-toolchain.env`
  - **系统文件**：`.DS_Store`、`Thumbs.db`
  - **临时文件**：`*.tmp`、`*.log`、`/logs/`、`/tmp/`
  - **覆盖率报告**：`*.lcov`、`/coverage/`、`/test-results/`
  - **工具链与第三方**：`/.toolchains/`、`/third_party/tailscale`、`.superpowers/`
  - **Agent 配置**：`/.codex/`、`/.claude/`、`/.codebuddy/`、`/.trae/`等
  - **Android 本地配置**：`apps/android/local.properties`
- 新增文件或目录时，确认是否属于上述类别，若是则及时更新 `.gitignore`。