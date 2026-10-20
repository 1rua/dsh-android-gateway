# DSH 宿主插件 API 调研报告（面向 Gateway Protocol v2.1 实现）

> 目标：为 `dsh-android-gateway` 提供**精确、可编码**的 DSH 宿主插件 API 报告。每个结论标注来源；代码骨架可直接照抄后补业务逻辑。
>
> 适用运行时：`/home/djbd/.dsh-cline/runtime/0.2.1-rc.2-r1/node_modules/@deepseek-ai/`（本机正在运行的 `dsh web` 进程 PID 131401 使用该目录，`--port 43535`）。
>
> 配套文档：[`gateway-protocol.md`](./gateway-protocol.md)（Gateway Protocol v2.1 规格真源）。本文只负责“DSH 侧能做什么、怎么做”，不重复协议字段表。

---

## TL;DR（先读这段）

1. **不用新造 Agent 框架**：`ctx.agents.create({sessionId, meta:{cwd, agentPreset}, agentOptions, setup})` + `agent.followup()` + `agent.whenIdle()` 就是“跑一轮”；流式靠 `agent/assistant-stream`，耐久事实靠 `session/event`，取消是 `agent.cancel({kind:'user'})`。
2. **Web profile 的坑**：工具在 agent preset 里，`setup` 里必须 `ctx.agentPresets.mount(agentCtx, presetId)`，否则 agent 没工具。
3. **HTTP 有两条路线**：仓库现状用 `ctx.webServer`（共享 GUI 端口，SSE 支持，但禁绑 `0.0.0.0`、端口不可选）；若要做“真机局域网直连”，才需要自建 `node:http`。二者对适配层无影响（§6）。
4. **附件直接复用** `ctx.attachments`（`saveFileStream`/`saveImage` → `FileBlock`/`ImageBlock`），但图片会被归一化（sha256/尺寸会变），且永不自动 GC。
5. **协议状态必须自己存**（账号/设备/幂等/outbox/`conversationId↔sessionId`）：DSH 是单机单用户模型，且 Session 日志禁止新增事件类型。
6. **先验证 14 个 spike**（§11.3），尤其是 preset 下的工具可见性、`sessionController` 直调、手写 schema、取消后 `whenIdle`。
7. **本仓库的插件是“外部 checkout + 链接安装”**：从仓库路径 `import '@deepseek-ai/*'` 会 **MODULE_NOT_FOUND**（已实测，见 §0.3）。因此本文代码骨架一律**零 harness 依赖**：`Config` 手写 Standard Schema，消息用普通对象，模型切换用 `agent/request` 监听器。

---

## 0. 阅读约定与环境事实

### 0.1 路径约定

下文所有 DSH 包内路径都相对于：

```text
$RT = /home/djbd/.dsh-cline/runtime/0.2.1-rc.2-r1/node_modules/@deepseek-ai/
```

因此 `dsh-agent/lib/types/runtime-types.d.ts:157` 表示 `$RT/dsh-agent/lib/types/runtime-types.d.ts` 第 157 行。

标注等级：

| 标记 | 含义 |
|---|---|
| ✅源码 | 直接读 `.d.ts` / `lib/*.js` / README 确认 |
| ✅环境 | 在本机运行时/文件系统实测确认 |
| ⚠️待验证 | 由源码推断、但未实际运行验证；编码前必须写 1 个最小 demo 验证 |

### 0.2 已确认的环境事实

| 事实 | 值 | 来源 |
|---|---|---|
| 运行时版本 | `0.2.1-rc.2`（`@deepseek-ai/dsh` package.json） | ✅环境 |
| `DSH_HOME` | `/home/djbd/.dsh-cline` | ✅环境（`env`） |
| 活动 profile | `web`，目录 `$DSH_HOME/profiles/web` | ✅环境（`DSH_PROFILE` / `DSH_PROFILE_DIR`） |
| profile 声明的 bundles | `dsh-base`、`dsh-web-app`、`dsh-experimental-agent-team-profile`、`dsh-experimental-voice-input-bundle`、`dsh-experimental-auto-review`、`dsh-experimental-inspector-profile` | ✅环境（`profiles/web/package.json`） |
| profile 组合方式 | `cordis.yml` 为空根列表，patch 层依次叠加：bundles → profile `cordis.patch.yml` → `--patch` | ✅源码 `dsh/lib/profile-boot-*.js:76-80,115-117`；`dsh-app-boot/lib/index.js:509` |
| 会话日志根 | `$DSH_HOME/sessions`（`dshHomePath('sessions')`） | ✅源码 `dsh-base/cordis.patch.yml:138-141` |
| 附件根 | `$DSH_HOME/attachments/v1` | ✅源码 `dsh-attachment-local/README.md:55,84` |
| 存储根 | `$DSH_HOME/storages` | ✅源码 `dsh-base/cordis.patch.yml:184-193` |
| 共享 `node_modules` | `$DSH_HOME/profiles/node_modules`（195 个 `@deepseek-ai/*` 链接） | ✅环境（`ls`） |

### 0.3 必须先知道的两个“坑”

**坑 1：本仓库插件从外部 checkout 安装，`@deepseek-ai/*` 根本解析不到。**

实测（✅环境，2026-10-20）：

```bash
node -e "const {createRequire}=require('module'); \
  const r=createRequire('/mnt/data/projects/dsh-android-gateway/lib/index.js'); \
  console.log(r.resolve('@deepseek-ai/schemastery'))"
# → Error: Cannot find module '@deepseek-ai/schemastery' (MODULE_NOT_FOUND)
```

原因：本仓库在 `$DSH_HOME` 之外，Node 的 ESM/CJS 解析从插件文件真实路径向上找 `node_modules`，会走到 `/mnt/data/projects/dsh-android-gateway/node_modules`（仓库自己的依赖：`ajv`、`canonicalize` 等），**看不到** DSH 的包。而如果插件被**复制**进 `$DSH_HOME/profiles/web/node_modules/`，解析会走到 `$DSH_HOME/profiles/node_modules`——那里的 195 个软链指向的是另一套旧安装 `0.1.0-rc.7`（`/home/djbd/.local/node-v26.7.0/lib/node_modules/@deepseek-ai/dsh`），与运行中的 `0.2.1-rc.2` 不一致（✅环境：`readlink` + `package.json` 版本比对）。

因此三条路都不通：

| 安装形态 | `import '@deepseek-ai/x'` 的结果 |
|---|---|
| 外部 checkout 软链（当前仓库形态） | `MODULE_NOT_FOUND` |
| 复制进 profile node_modules | 解析到 `0.1.0-rc.7`（版本偏移） |
| 在仓库里 `dependencies` 声明 `@deepseek-ai/*` | rc 版本通常不可从公共 registry 安装；即使装上也是**第三份**副本 |

**结论（本报告代码的唯一前提）**：宿主插件**零 harness import**，只用：
- `node:` 内置模块；
- 仓库自有依赖（`ajv`、`canonicalize` 等）；
- `ctx` 上的服务 API（`ctx.agents` / `ctx.sessions` / `ctx.tools` / `ctx.attachments` / `ctx.sessionQuery` / `ctx.profileContext` …）；
- 普通 JSON 对象构造 `UserMessage`、`ToolDefinition`、`Config`（手写 Standard Schema）。

这也是为什么下面的骨架（除明确标注“仅作参考”的 schemastery / defineTool 片段外）不 `import` 任何 `@deepseek-ai/*`。

**坑 2：Web profile 的“工具在 preset 里，不在 host 里”。**
`dsh-web-app/cordis.patch.yml:460-520` 把 `tool-bash`、`tool-fs`、`tool-fs-search`、`tool-skill` 等 host 行 `disabled: true`，改由每个 session 挂载的 agent preset 提供（✅源码）。因此在本 profile 里 `ctx.agents.create()` 创建出来的 agent **默认没有这些工具**，必须显式挂载 preset（§9.2）。

---

## 1. 宿主插件如何声明与加载

### 1.1 包清单（`package.json`）

官方技能文档给出的最小 Host-only bundle（✅源码 `dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:9-27`）：

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

字段语义（✅源码 `dsh-package-manifest/lib/types/types.d.ts`）：

| 字段 | 行号 | 说明 |
|---|---:|---|
| `dsh.bundle.patch` | 65-69（`patch: string \| string[]`，第 68 行） | 一个 patch 文件路径，或按序应用的路径数组，**相对于声明包根** |
| `dsh.profile.bundles` | 71-74 | profile 的 bundle 层顺序列表（写包名） |
| `dsh.client` | 76-95 | 客户端插件元数据（本项目不需要） |
| `icon` | 14 | 展示图标（Plugin Manager / 设置页读取） |
| `engines.dsh` | 47-58 | DSH 版本兼容声明（安装时会校验） |

发布/安装到 profile 时还要有 `exports`（`./locale/*.json`、`./icon` 等）与 `files` 白名单，详见 `host-plugin.md:31-51`。本地目录安装会直接链接 checkout，`files` 不过滤，但仍建议写全。

### 1.2 `cordis.patch.yml` 语法

patch 是一个**映射列表**，每个映射要么 `insert`，要么按 `id` 覆盖已有行（✅源码 `dsh-agent-preset/skills/cordis-composition-reference/SKILL.md:10-25`）：

| 写法 | 效果 |
|---|---|
| `- insert: [rows]` | 追加行；若 `id` 指向已有 `group: true` 行，则追加进该 group 的 `config` 列表 |
| `- id: <已有行> ...` | 覆盖该行；字段替换，**`config` 整体替换、不深合并**（必须重述所有字段）；`name` 非空表示“断言”而非改名 |
| `group: true` + `name: cordis:group` | `config` 成为嵌套 entry 列表，可按 id 被 patch |
| `disabled` | 布尔/null/`!!js` 表达式；被禁用行可省略必填 `config` |
| `isolate` | 服务名 → `true`/realm 标签，隔离服务实例 |
| `!!js` 表达式 | 在 `config` 内、该行声明的 `inject` 激活后求值，可访问 `ctx.<service>`；可用的 home 解析函数如 `dshHomePath(...)` |

注意：`!!js` 只允许出现在 `config` 内；其它行元数据保持字面量（同文件 22 行）。

行字段：`id`、`name`（包说明符；插入相对路径时相对 patch 文件所在目录）、可选 `config`、`disabled`、`inject`、`intercept`、`isolate`（同文件 18 行）。

### 1.3 导出形式（`apply` / 服务类）

`index.js` 只能二选一（✅源码 `host-plugin.md:57-64`）：

1. `export function apply(ctx, config) {}`，可另带 `export const inject = [...]` 与 `export const Config`；
2. 默认导出（default export）一个 Service 类。

**不要混用**。Cordis Loader 的 `unwrapExports` 规则是 `exports.default ?? exports`，且当 `__esModule` 为真时再取一次 `default`（✅源码 `cordis-plugin-loader/lib/index.js:667-672`）。这就是 `dsh-sdk-jsonrpc-server` 注释里强调的“保留具名导出、不要加 default export，否则 Loader 会丢失 `name`/`inject`/`Config`/`apply`”（✅源码 `dsh-sdk-jsonrpc-server/lib/index.js:369-372` 附近注释）。

**`apply` 的返回值就是 effect**：Cordis 的 `Effect` 类型既被 `ctx.effect()` 接受，也被“plugin startup”接受；可以是单个 disposer、disposer 的 Promise，或逐个产出 disposer 的（异步）迭代器（✅源码 `cordis/lib/types/fiber.d.ts:43-49`）。实践上推荐**在 `apply` 里显式 `ctx.effect(...)`**，可读性与顺序控制更好（`dsh-client-hmr`、`dsh-host-open-in-app` 都是这个写法，见 `dsh-host-open-in-app/lib/index.js:1271-1283`）。

### 1.4 `inject` 的两种写法

| 写法 | 何时用 | 来源 |
|---|---|---|
| `export const inject = ['agents', 'sessions']` | 硬依赖；服务缺失时插件**保持未激活**而不是抛错 | ✅源码 `host-plugin.md:61`；`dsh-sdk-jsonrpc-server/lib/index.js:373` |
| `ctx.inject(['webServer'], (webCtx) => {...})` | 可选服务；只在服务存在时激活那段逻辑，块内注册随 fiber 卸载 | ✅源码 `host-plugin.md:64`；`dsh-tool-fs/lib/index.js:984-985` 注释与用法 |

`inject` 数组里的名字就是 Context 上的服务键（如 `agents`、`sessions`、`tools`、`webServer`、`attachments`、`sessionQuery`、`workingDirectory`、`systemPrompt`、`llm`、`agentPresets`、`agentDefaultModel`）。

### 1.5 `Config` 校验（Standard Schema；schemastery 或手写）

Cordis 用 **Standard Schema** 接口校验配置：`runtime.Config['~standard'].validate(config)`，异步校验直接抛 `TypeError`，失败抛 `ValidationError`（✅源码 `cordis/lib/index.js:956-962`）。所以 `Config` 只要是实现了 `~standard` 的对象即可，`@deepseek-ai/schemastery` 是官方实现。

已装插件里的 schemastery 写法（**仅作参考**；只有插件能被解析到该包时才可用，例如源码直接放在 DSH 安装树内）：

```js
import Schema from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  maxTokensAsSuccess: Schema.boolean().default(false),   // dsh-sdk-jsonrpc-server/lib/index.js:373-374
  pollIntervalMs: Schema.number().step(1).min(1).default(500), // dsh-client-hmr/lib/index.js:25
})
```

`apply(ctx, config)` 收到的 `config` **已应用默认值**（✅源码 `dsh-sdk-jsonrpc-server/lib/index.js:375` 的 `resolvedConfig = config` 用法）。另外 `host-plugin.md:64` 提到：插件声明 `Config` 后，安装时会用 `Config.listConfigs` 取 schema 展示给用户；写用户 patch 前应先查该 schema 并跟随 `$defs` 引用。

**本仓库推荐写法：手写 Standard Schema，零依赖**（Cordis 只要求 `~standard.validate`，✅源码 `cordis/lib/types/registry.d.ts:83-92` 与 `lib/index.js:956-962`）：

```js
const DEFAULTS = {
  host: '127.0.0.1',
  port: 8790,
  heartbeatMs: 15000,
  turnTimeoutMs: 30 * 60 * 1000,
}

/** Standard Schema v1（手写）；Cordis 在激活前调用 validate，失败抛 ValidationError。 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-android-gateway',
    validate(input) {
      const raw = (input ?? {})
      const issues = []
      const host = raw.host ?? DEFAULTS.host
      if (typeof host !== 'string' || host.trim() === '') issues.push({ message: 'host must be a non-empty string', path: ['host'] })
      const port = raw.port ?? DEFAULTS.port
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) issues.push({ message: 'port must be an integer in 1..65535', path: ['port'] })
      const heartbeatMs = raw.heartbeatMs ?? DEFAULTS.heartbeatMs
      if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1000) issues.push({ message: 'heartbeatMs must be an integer >= 1000', path: ['heartbeatMs'] })
      const turnTimeoutMs = raw.turnTimeoutMs ?? DEFAULTS.turnTimeoutMs
      if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1000) issues.push({ message: 'turnTimeoutMs must be an integer >= 1000', path: ['turnTimeoutMs'] })
      const gatewayRoot = raw.gatewayRoot
      if (typeof gatewayRoot !== 'string' || gatewayRoot.trim() === '') issues.push({ message: 'gatewayRoot must be an absolute path', path: ['gatewayRoot'] })
      if (issues.length > 0) return { issues }
      return { value: { host, port, heartbeatMs, turnTimeoutMs, gatewayRoot } }
    },
  },
}
```

⚠️待验证（U-15）：没有 `listConfigs` 时，Plugin Manager 的“配置编辑”UI 可能不显示字段；安装/启用不受影响。若必须在 UI 里可编辑，再考虑给仓库加 `@deepseek-ai/schemastery` 依赖（仍需解决版本/解析问题）。

> 说明：`Config` 里不要读 `process.env` 的敏感值；运行期可变配置用 `Volatile<T>`（Cordis 支持，`dsh-agent-loop` 的 `maxParallelToolCalls: Volatile<number>`，✅源码 `dsh-agent-loop/lib/types/index.d.ts:85`）。

### 1.6 安装、启用与生效

- `plugin_manager` 的 `install_bundle` 负责包安装与 bundle 选择，不要用 shell 复刻（✅源码 `host-plugin.md:66-70`）。
- 安装后 profile 的 `package.json` 会记录 `dsh.profile.bundles`（✅源码 `dsh-plugin-manager/lib/index.js:322-347` 的 `reconcileProfilePlugins`/`writeProfileBundles` 流程）。
- **替换已安装的包必须重启**才能加载新的 JS 生成；新装 bundle 可能通过 HMR 生效（同文档 70 行）。
- 本地目录安装是“链接 checkout”，改完文件后通常需要重新激活/重启。

### 1.7 最小完整示例（可直接跑）

目录：

```text
dsh-android-gateway/
  package.json
  cordis.patch.yml
  lib/index.js          # 本仓库由 tsc 从 src/ 构建到这里
  locale/en.json        # 建议：Plugin Manager 展示用
  locale/zh.json
  icon.svg
```

> 本仓库现有 `package.json` 的 `exports["."]` 已是 `./lib/index.js`，构建脚本 `npm run build` 产出该文件；下例按同一布局给出。

`package.json`：

```json
{
  "name": "@local/dsh-android-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Android Gateway Protocol v2.1 host for DSH",
  "exports": {
    ".": "./lib/index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": [
    "lib/",
    "cordis.patch.yml",
    "locale/*.json",
    "icon.svg"
  ],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: android-gateway
      name: '@local/dsh-android-gateway'
      config:
        host: 127.0.0.1
        port: 8790
        gatewayRoot: !!js dshHomePath('android-gateway')
```

> `!!js dshHomePath('android-gateway')` 会在该行 `inject` 激活后求值（✅源码 `cordis-composition-reference/SKILL.md:22`）；`dshHomePath` 由 launcher 注入到 Loader 上下文（✅源码 `dsh-app-boot/lib/types/index.d.ts:26` 注释）。

`lib/index.js`：

```js
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'

/** 插件名（日志、Plugin Manager 识别用） */
export const name = 'android-gateway'

/** 硬依赖：没有这些服务就不激活 */
export const inject = ['agents', 'sessions']

// 手写 Standard Schema（零依赖；完整版见 §1.5）
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-android-gateway',
    validate(input) {
      const raw = input ?? {}
      const issues = []
      const host = raw.host ?? '127.0.0.1'
      const port = raw.port ?? 8790
      const heartbeatMs = raw.heartbeatMs ?? 15000
      const turnTimeoutMs = raw.turnTimeoutMs ?? 30 * 60 * 1000
      if (typeof host !== 'string' || host === '') issues.push({ message: 'host must be a non-empty string', path: ['host'] })
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) issues.push({ message: 'port must be 1..65535', path: ['port'] })
      if (typeof raw.gatewayRoot !== 'string' || raw.gatewayRoot === '') issues.push({ message: 'gatewayRoot is required', path: ['gatewayRoot'] })
      if (issues.length > 0) return { issues }
      return { value: { host, port, heartbeatMs, turnTimeoutMs, gatewayRoot: raw.gatewayRoot } }
    },
  },
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{host:string, port:number, gatewayRoot:string, heartbeatMs:number, turnTimeoutMs:number}} config
 */
export function apply(ctx, config) {
  const instanceId = randomUUID()
  ctx.logger.info('android-gateway %s: mounting (port=%d)', instanceId, config.port)

  // 一切注册都放进 effect：插件卸载/禁用时按逆序执行清理
  ctx.effect(() => {
    let disposed = false
    const ready = mkdir(config.gatewayRoot, { recursive: true })

    return async () => {
      disposed = true
      await ready
      ctx.logger.info('android-gateway %s: unmounted', instanceId)
    }
  }, 'android-gateway: data root')

  // 复杂逻辑（HTTP server / SSE / agent 驱动）见 §2、§3、§6、§10
}
```

激活检查点：

1. `plugin_manager list_plugins` 能看到 `android-gateway` 行且 `enabled`；
2. 日志出现 `android-gateway ...: mounting`；
3. `curl http://127.0.0.1:8790/...`（完成 §6 后）有响应；
4. 禁用插件后端口关闭、日志出现 `unmounted`。

---

## 2. 拿到 Agent / Session 服务

> **仓库现状先对齐**：`src/dsh/bridge.ts` 走的是**上层 API**——`ctx.sessionController.create/prompt/cancel/rename` + `ctx.sessionQuery.readSurface/readTitle` + `ctx.fileUploads`，而不是直接 `ctx.agents.followup`。两条路都能完成“跑一轮”，但语义与依赖不同：
>
> - 上层 API：自带 preset 解析、默认模型、写锁、`requestId` 幂等、图片 admission、文件 receipt、冷会话自动 resume；代价是只在 web profile 可用，且失败码是 `RemoteError`。
> - 底层 API：`ctx.agents` + `ctx.sessions`，通用、可控，但要自己实现上述策略。
>
> 下文先讲**底层机制**（理解 DSH 原理必需），§2.7 给出**上层对照表**。两条路的流式/取消/历史都汇合到同一批事件（§3/§4）。

### 2.1 服务名对照（先纠正几个常见误解）

| 你以为的 | 实际存在的 | 提供者 | 说明 |
|---|---|---|---|
| `ctx.agent` | ❌ 不存在 | — | 只有 `ctx.agents`（注册表）与 `agent.ctx`（agent 作用域） |
| `ctx.session` | ❌ 不存在 | — | 只有 `ctx.sessions`（SessionStore） |
| `ctx.sessionStore` | ❌ 不存在 | — | 同上 |
| `ctx.agents` | ✅ `AgentRegistry` | `dsh-agent` | 创建/恢复/查找 agent；`ctx.agents.create()` 返回 `AgentHandle`（✅源码 `dsh-agent/lib/types/index.d.ts:198-379,278,286`） |
| `ctx.sessions` | ✅ `SessionStore` | `dsh-session` | 内存会话存储；`create/get/list/fork/flush`（✅源码 `dsh-session/lib/types/index.d.ts:378-516`） |
| `ctx.agentLoop` | ✅ `AgentLoop` | `dsh-agent-loop` | 驱动实现/工厂；业务插件通常不需要直接用（✅源码 `dsh-agent-loop/lib/types/index.d.ts:99,164,174`） |
| `ctx.sessionQuery` | ✅ `SessionQueryEngine` | `dsh-session-query`（web profile 由 `dsh-session-query-sqlite` 提供） | 冷/热统一历史读取（✅源码 `dsh-session-query/lib/types/index.d.ts:35-153`） |
| `ctx.sessionController` | ✅ `SessionController` | `dsh-api-session-controller`（**仅 web profile**） | 上层会话业务 API：create/prompt/page/follow/cancel（✅源码 `dsh-api-session-controller/lib/types/index.d.ts:52-215`） |
| `ctx.workingDirectory` | ✅ | `dsh-working-directory` | 读/改 cwd（✅源码 `dsh-working-directory/lib/types/index.d.ts:64-83`） |
| `ctx.attachments` | ✅ | `dsh-attachment` 抽象（`dsh-attachment-local` 实现） | 附件存取（✅源码 `dsh-attachment/lib/types/index.d.ts:18-130`） |
| `ctx.tools` | ✅ `ToolRuntime` | `dsh-tools` | 工具注册表（✅源码 `dsh-tools/lib/types/index.d.ts:527-852`） |
| `ctx.systemPrompt` | ✅ | `dsh-system-prompt` | 提示词 section 注册（✅源码 `dsh-system-prompt/lib/types/index.d.ts:250`） |
| `ctx.agentPresets` | ✅ | `dsh-agent-preset-registry` | preset 挂载/选择（✅源码 `dsh-agent-preset-registry/lib/types/index.d.ts:22-160`） |
| `ctx.agentDefaultModel` | ✅ | `dsh-agent-default-model` | 部署默认模型（✅源码 `dsh-agent-default-model/lib/types/index.d.ts:42-50`） |
| `ctx.llm` | ✅ | `dsh-llm` | provider/model 目录与 `prepareCall`（✅源码 `dsh-llm/lib/types/index.d.ts:281,367,391,407`） |
| `ctx.webServer` | ✅ | `dsh-host-webserver`（仅 web/GUI 组合） | HTTP 路由注册（✅源码 `dsh-host-webserver/lib/types/index.d.ts:129-224`） |
| `ctx.profileContext` | ✅ | launcher 注入 | profile/home 路径事实（✅源码 `dsh-app-boot/lib/types/profile-context.d.ts:10-31`） |

### 2.2 `ctx.agents` 精确签名

```ts
class AgentRegistry extends Service {
  create(options: CreateAgentOptions): Promise<AgentHandle>          // index.d.ts:278
  resume(options: ResumeAgentOptions): Promise<AgentHandle>          // index.d.ts:286
  get(id: SessionId): Agent | undefined                              // index.d.ts:343
  list(): Agent[]                                                    // index.d.ts:357
  roots(): Agent[]                                                   // index.d.ts:364
  isOwnedBy(id: SessionId, owner: Agent): boolean                    // index.d.ts:352
  withInitiator<T>(agent: Agent, operation: () => T): T              // index.d.ts:241
  withoutInitiator<T>(operation: () => T): T                         // index.d.ts:253
  setFactory(factory: AgentFactory): () => void                      // index.d.ts:266
}
interface AgentHandle { agent: Agent; dispose(): Promise<void> }     // index.d.ts:143-146
```

`CreateAgentOptions` 字段（✅源码 `dsh-agent/lib/types/index.d.ts:48-104`）：

| 字段 | 行号 | 说明 |
|---|---:|---|
| `sessionId` | 50 | 必填；agent 与 session 共用的身份（`SessionId` 运行时就是 string） |
| `parentAgent?` | 52 | 运行时父子关系；做顶层会话时省略 |
| `meta.cwd?` | 64-65 | **绑定工作目录**（必须是绝对路径，由 Session 校验） |
| `meta.parentSession?` / `isSeeded?` | 66-67 | fork 血缘，本项目的会话复制功能可能用到 |
| `meta.origin?` / `delegationDepth?` | 68-70 | 子 agent 标记；本项目的子会话/多设备可分阶段使用 |
| `meta.agentPreset?` | 71 | **记录到 SessionHeader 的 preset id**（durable） |
| `inheritedEventCount?` | 73 | fork 前缀长度 |
| `seed?` | 80 | 回放事件数组 |
| `agentOptions?` | 82 | `{ provider, model, reasoningEffort?, maxTokens? }` |
| `signal?` | 84 | 仅创建期取消 |
| `setup?` | 103 | `(agentCtx, agent) => void \| Promise<...>`；**发布前**组合 agent 作用域世界 |

`ResumeAgentOptions`：`{ resumeSessionId, parentAgent?, agentOptions?, signal?, setup? }`（✅源码 `index.d.ts:109-128`）。注意：`resume` 必须在 `ctx.sessionPersistence` 存在时调用（✅源码 `index.d.ts:177-184` 注释；web profile 已挂 `session-persistence-jsonl`）。

### 2.3 `Agent` 句柄的精确签名

```ts
interface Agent {
  readonly id: SessionId                                      // types.d.ts:13
  readonly options: AgentOptions                              // runtime-types.d.ts:141
  readonly session: Session                                   // runtime-types.d.ts:143
  readonly inbox: Inbox                                       // runtime-types.d.ts:145
  readonly status: 'idle' | 'running'                         // runtime-types.d.ts:147,90
  readonly ctx: Context                                       // runtime-types.d.ts:149
  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void   // :157
  whenIdle(): Promise<void>                                   // :164
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>   // :174
  send(message: UserMessage, target: 'next-turn'|'next-step', wakeup: boolean): void // :186
  followup(message: UserMessage): void                        // :192
  steer(message: UserMessage): void                           // :200
  inject(message: UserMessage): void                          // :209
}
```

语义要点（✅源码同文件）：

- `followup`：普通下一轮，唤醒 driver；该消息**独占一个 turn**（192 行注释）。
- `steer`：最近一个 step 的输入；运行中在下一个 step 边界消费；空闲时也会开一个 turn（200 行）。
- `inject`：只入队模型可见上下文，**不唤醒**；空闲时一直挂着，直到后续 followup/steer 唤醒（209 行）。
- `whenIdle`：整个 agent 达到静止后 resolve；**不保证某条消息的结算**（164 行）。
- `cancel`：中止当前 turn；默认**同时清空队列**，`{ keepInbox: true }` 只中止当前 turn（157 行 + README 177 行）。

### 2.4 Session 对象（读历史、读模型路由）

```ts
class Session {
  readonly header: SessionHeader                     // index.d.ts:150
  get id(): SessionId                                // :154
  get seq(): SessionLogOffset                        // :239（当前日志长度，运行时是 number）
  get surface(): SessionSurface                      // :141
  append<T>(type, data, ...opts): SessionEvent<T>    // :277
  deriveMessages(): Message[]                        // :347（模型可见历史，带缓存、深冻结）
  deriveEventMessage(event): Message | null          // :354
  requestHeader(): EpochHeader | undefined           // :303（最近一次请求头：provider/model/tools）
  requestContext(): RequestContext | undefined       // :312
  toolHistory(): ToolHistory                         // :322
  eventAt(seq) / snapshotEvents(...) / ownEvents()   // :213/:224/:231 —— 已废弃，新代码禁止调用（:206-231 注释）
}
```

`SessionStore`：

```ts
create(id?, options?): Session                        // index.d.ts:414
prepare(id?, options?): Session                       // :434（不入 store）
enter(session): () => void                            // :457
announce(session): void                               // :467
flush(session): Promise<boolean>                      // :483（durability barrier）
get(id): Session | undefined                          // :491
list(): Session[]                                     // :496
fork(source, boundary?, childSessionId?): Session     // :513
registerMessageProjection(p): () => Promise<void>     // :391
```

### 2.5 程序化“创建 session → 绑定 cwd → 发消息 → 跑一轮 → 取结果”

完整流程（✅源码组合：`dsh-sdk-jsonrpc-server/lib/index.js:318-341` + `dsh-headless/lib/index.js:300-360` + `dsh-api-session-controller/lib/index.js:274-306,352-363`）：

```js
// 依赖：ctx.agents、ctx.sessions；可选 ctx.agentPresets、ctx.agentDefaultModel
// selection 由 resolveSelection(ctx, requested) 得到（§9.1），必填
async function createSession(ctx, { sessionId, cwd, selection, presetId }) {
  const setup = async (agentCtx) => {
    // 1) 让后续每个 step 使用调用方选择的模型（零 harness import 的写法）
    //    原理：agent/request 是 waterfall，返回替换后的 config 即切换路由（§9.1）
    agentCtx.on('agent/request', async (_payload, next) => {
      const config = await next()
      return {
        ...config,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      }
    })

    // 2) Web profile 必须：把 preset 的组合挂到该 agent 作用域
    const presets = ctx.get('agentPresets')
    if (presets !== undefined) await presets.mount(agentCtx, presetId)
  }

  const handle = await ctx.agents.create({
    sessionId,                                  // string；建议 'agsess_' + uuid
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    },
    meta: { cwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
    setup,
  })
  return handle
}

/** 发一条用户消息并等这一轮结束；返回本轮新增事件区间与 turn 号 */
async function runOneTurn(ctx, handle, { text, content, source = { kind: 'user' } }) {
  const agent = handle.agent
  const before = Number(agent.session.seq)

  const message = {
    id: `msg_${crypto.randomUUID()}`,
    role: 'user',
    content: content ?? [{ type: 'text', text }],
    source,
  }
  agent.followup(message)

  // 若需要精确关联：用 agent/inbox/claimed 拿到 turn 号（payload.turn）
  const claimed = await waitForClaim(ctx, agent, message.id)
  await agent.whenIdle()                        // 整 agent 静止（含它自己触发的后续 step）

  // 取本轮新增事件：readSession 返回整份快照（§4.3），按 before 过滤；
  // 正式实现建议维护本地 watermark，避免每次全量 replay。
  const { events: allEvents } = await ctx.sessionQuery.readSession(agent.session.id)
  const events = allEvents.filter((event) => Number(event.seq) >= before)
  return { messageId: message.id, turn: claimed?.turn, events }
}
```

组合起来用：

```js
const selection = resolveSelection(ctx, { provider: 'deepseek-official', model: 'deepseek-flash' })
const handle = await createSession(ctx, { sessionId: `agsess_${randomUUID()}`, cwd, selection, presetId: 'standard' })
owned.add(handle)                                  // 便于插件卸载时统一回收

const { messageId, turn } = await runOneTurn(ctx, handle, { text: '你好' })
await ctx.sessions.flush(handle.agent.session)     // 耐久屏障（可选但推荐）
```

`waitForClaim`（用于把协议 `generationId` 绑定到 DSH turn）：

```js
function waitForClaim(ctx, agent, messageId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error('claim timeout')) }, timeoutMs)
    const stop = ctx.on('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
      if (subject !== agent || message.id !== messageId) return
      clearTimeout(timer); stop(); resolve({ turn })
    })
  })
}
```

> 事件签名提醒：`agent/inbox/claimed` 的 payload 是 `{ agent, message, turn }`（✅源码 `dsh-agent/lib/types/runtime-types.d.ts:277-281`）。

**拿“生成结果”的三种口径**：

| 口径 | 做法 | 适用 |
|---|---|---|
| 最终文本 | `await agent.whenIdle()` 后取最后一条 `assistant/message` 的 `data.message.content` 文本块 | 一次性结果、`final` 事件 |
| 结构化历史 | `agent.session.deriveMessages()` | 需要模型可见消息（含 system/developer） |
| 流式 | 订阅 `agent/assistant-stream`（§3） | SSE delta |

**耐久性**：需要落盘保证时 `await ctx.sessions.flush(agent.session)`（✅源码 `dsh-session/lib/types/index.d.ts:483`；headless 在收尾时调用，`dsh-headless/lib/index.js:356`）。

### 2.6 绑定/切换工作目录

- 创建时：`meta.cwd`（绝对路径，否则 `create` 抛错；✅源码 `dsh-session/lib/types/index.d.ts:414` 注释）。
- 运行中读取：`ctx.workingDirectory.get(session)`（同步，✅源码 `dsh-working-directory/lib/types/index.d.ts:64`）。
- 运行中修改：`await ctx.workingDirectory.set(agent, path)`（会校验 fs、提交 `working-directory/change` 事件、投递用户上下文；✅源码 `:83` + README）。
- 恢复后修复丢失目录：`await ctx.workingDirectory.ensure(agent)`（✅源码 `:73`）。

> 对 Gateway：会话目录建议由 App 的“工作区/项目”映射到 DSH 的绝对 cwd；`set()` 可支持 App 切换项目，但会进入模型上下文并改变工具行为，需要产品层确认语义。

### 2.7 上层 API 对照（`ctx.sessionController`，仓库现状）

| 协议动作 | 上层调用 | 与底层的差异 | 依据 |
|---|---|---|---|
| 建会话 | `sessionController.create({ sessionId?, cwd?, agentPreset? })` | 解析默认 preset；可复用空白会话；cwd 冲突/占用会拒绝；返回宿主实际使用的 `sessionId`（**可能不等于请求值**） | ✅源码 `dsh-api-session-controller/lib/types/types.d.ts:284-300`；`lib/index.js:266-280` |
| 发消息 | `sessionController.prompt({ requestId, sessionId, mode: 'queue' 或 'steer', content }, signal)` | `requestId` 幂等；图片走 `attachments` admission；文件走 `fileUploads` receipt；冷会话会先 resume | ✅源码 `types.d.ts:332-344`；README:52 |
| 取消 | `sessionController.cancel({ sessionId })` | **已固定为 `agent.cancel({kind:'user'},{keepInbox:true})`**（保留排队）；agent 不在线时抛 `session/not-found` | ✅源码 `lib/index.js:1061-1067` |
| 改标题 | `sessionController.rename({ sessionId, title })` | 写 `session/title` 事件并返回 seq | ✅源码 `types.d.ts:311-320` |
| 历史 | `sessionQuery.readSurface(sessionId)` / `sessionController.page()` | readSurface 是当前 surface（replace 已压缩）；page 是 Turn 对齐分页 | ✅源码 §4.3 |
| 模型 | `sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })` | 校验后写 `model/selection`，下一轮生效 | ✅源码 `types.d.ts:301-307`；`lib/index.js:312-315` |
| 附件 | `fileUploads.uploadStream(...)` → receipt → `prompt` 的 file part | 与 `attachments.saveFileStream` 不同：receipt 绑定 Session/Agent，更安全但更绕 | ✅源码 `dsh-client-file-upload/lib/types/index.d.ts:45-70` |

**对本项目的含义**：

- 仓库形态下 `create` 返回的 `sessionId` 必须**覆盖**本地映射（协议 `conversationId → sessionId` 以返回值为准）；
- 取消语义已经就是“保留排队”，与协议“只停当前 generation”一致（✅源码 `lib/index.js:1065`）；
- `prompt` 的 `requestId` 可直接承接协议的 `clientMessageId`/`requestId` 做幂等（注意格式：`SessionRequestId` 是 brand，运行时是 string）；
- 如果以后要脱离 web profile（headless/SDK 部署），需要把 §2.5 的底层路径实现一遍作为 fallback。

---

## 3. 订阅一轮运行的流式事件与取消

### 3.1 三类事件，先分清“耐久”与“瞬时”

| 事件 | 模式 | 触发时机 | 是否进入 session 日志 | 来源 |
|---|---|---|---|---|
| `session/event` | emit（提交后、fire-and-forget） | 每次 `Session.append` 提交后 | 是（事件本体） | ✅源码 `dsh-session/lib/types/index.d.ts:51-61` |
| `agent/assistant-stream` | emit（进程内） | 每个模型 attempt 的 start/chunk/end | **否**（只有最终 settlement 落盘） | ✅源码 `dsh-agent/lib/types/runtime-types.d.ts:357-369`；README 同段 |
| `agent/status` | emit | `idle ⇄ running` | 否 | ✅源码 `:252-255` |
| `agent/error` | emit | step/turn 出错（即使无日志位置） | 否（错误进 `turn/end.reason`） | ✅源码 `:392-407` |
| `agent/created` / `agent/disposed` | serial / emit | agent 发布/移除 | 否 | ✅源码 `:227-242` |
| `agent/inbox/*` | emit | 入队/认领/丢弃 | `agent/inbox/spliced` 落盘 | ✅源码 `:263-292`；`types.d.ts:86-93` |
| `session/created` / `session/disposed` | emit | 会话发布/移除 | 否 | ✅源码 `dsh-session/lib/types/index.d.ts:41-50` |

**关键约束**：`assistant` 的 token 增量是**瞬时**的；`assistant/message` 落盘的是“完整消息 + 紧凑流”（✅源码 `dsh-agent/README.md:67`；`dsh-session/lib/types/types.d.ts:331-339`）。所以断线重连后**不能**逐字重放，只能从 `assistant/message` 拿全文——这正是 `dsh-api-session-controller` 需要自建 assistant-stream baseline 的原因（`assistantStream?: true` 的 `SessionFollowFrame`，✅源码 `dsh-api-session-controller/lib/types/types.d.ts:482-550`）。

### 3.2 `agent/assistant-stream` 的帧结构

```ts
type AssistantStreamFrame =
  | { type: 'start'; attemptId; revision; turn; step }
  | { type: 'chunk'; attemptId; revision; index; time; chunk: StreamChunk }
  | { type: 'end'; attemptId; revision; index;
      outcome: { kind: 'committed'; eventType: 'assistant/message'|'assistant/attempt'; seq }
             | { kind: 'abandoned' } }
```

（✅源码 `dsh-agent/lib/types/runtime-types.d.ts:107-137`；`revision` 在同一 Agent 生命周期内单调，`chunk.index` 从 0 稠密递增，`end.index` 是 chunk 数量。）

`StreamChunk`（✅源码 `dsh-llm/lib/types/types.d.ts:434-464`）：

| `type` | 字段 | 映射到 Gateway |
|---|---|---|
| `block-start` | `index`, `blockType` | 可忽略/用于分段 |
| `text-delta` | `index`, `text` | `conversation.message.delta` 的正文增量（协议要求**累积全文**，需自行累加） |
| `reasoning-delta` | `index`, `text` | 思考内容（协议可放 `message.status`/扩展字段，需产品定） |
| `tool-call-delta` | `index`, `id`, `name?`, `argumentsDelta` | 工具调用流（可选展示） |
| `block-end` | `index`, `block`（`ContentBlock`） | 完整块：`text`/`reasoning`/`tool-call`/`image`/`file` |
| `usage` | `usage`（`TokenUsage`） | 计费/用量 |
| `finish` | `reason`（`stop`/`tool-calls`/`max-tokens`/`aborted`/`error`）、`replayState?` | 结束原因 |

`ContentBlock` 全量（✅源码 `dsh-llm/lib/types/types.d.ts:46-126`）：`text`、`reasoning`、`image`（`attachment: ImageAttachmentRef`）、`file`（`attachment: FileAttachmentRef`）、`tool-call`（`id`,`name`,`arguments`）、`tool-addition`、`tool-removal`。

### 3.3 订阅代码骨架（含取消与背压）

```js
function attachStreamBridge(ctx, onEvent) {
  /** @type {Map<string, { text: string, reasoning: string, index: number }>} */
  const perSession = new Map()

  const disposeSession = ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    // 事件是提交后同步分发；重活必须排队，不要在这里做 IO
    queueMicrotask(() => onEvent({ kind: 'session-event', sessionId, event }))
  })

  const disposeStream = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = String(agent.session.id)
    if (frame.type === 'start') {
      perSession.set(sessionId, { text: '', reasoning: '', index: 0 })
      onEvent({ kind: 'assistant-start', sessionId, turn: frame.turn, step: frame.step, attemptId: frame.attemptId })
      return
    }
    if (frame.type === 'end') {
      onEvent({ kind: 'assistant-end', sessionId, outcome: frame.outcome })
      perSession.delete(sessionId)
      return
    }
    const state = perSession.get(sessionId)
    if (state === undefined || frame.index !== state.index) return // 丢帧就放弃逐字，等 assistant/message
    state.index += 1
    const chunk = frame.chunk
    if (chunk.type === 'text-delta') {
      state.text += chunk.text
      onEvent({ kind: 'text-delta', sessionId, delta: chunk.text, text: state.text }) // text = 累积全文
    } else if (chunk.type === 'reasoning-delta') {
      state.reasoning += chunk.text
      onEvent({ kind: 'reasoning-delta', sessionId, delta: chunk.text })
    } else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
      onEvent({ kind: 'tool-call', sessionId, call: chunk.block })
    } else if (chunk.type === 'usage') {
      onEvent({ kind: 'usage', sessionId, usage: chunk.usage })
    } else if (chunk.type === 'finish') {
      onEvent({ kind: 'finish', sessionId, reason: chunk.reason })
    }
  })

  const disposeStatus = ctx.on('agent/status', ({ agent, status }) => {
    onEvent({ kind: 'status', sessionId: String(agent.session.id), status })
  })
  const disposeError = ctx.on('agent/error', ({ agent, turn, step, error }) => {
    onEvent({ kind: 'agent-error', sessionId: String(agent.session.id), turn, step, error })
  })

  return () => { disposeSession(); disposeStream(); disposeStatus(); disposeError() }
}
```

说明：

- 未打 scope 标签的监听器是**全局**的（✅源码 `dsh-scope/README.md:34`：“Untagged listeners stay global”）；用 `agent.session.id` 过滤自己的会话。
- `ctx.on` 返回 disposer（`() => boolean`，✅源码 `cordis/lib/types/events.d.ts:88`）。
- 不要在 `session/event` 回调里做网络写；它是提交后同步分发，慢回调会拖慢所有 append（✅源码 `dsh-session/lib/types/index.d.ts:51-61` 注释：observer failures contained，但仍在提交路径上调用）。

### 3.4 取消一轮运行

```js
// 用户点“停止生成”
agent.cancel({ kind: 'user' })                    // 默认同时清空排队消息
// 只停当前 turn、保留排队
agent.cancel({ kind: 'user' }, { keepInbox: true })
```

- cause 是稳定枚举 `user | parent | hook(reason) | disposed`（✅源码 `dsh-session/lib/types/types.d.ts:149-158`）。
- 取消后：如果本轮已产生可见文本，会以 `interrupted: true` 落一条 `assistant/message`；若什么都没产生，则 `turn/end.reason = { kind: 'aborted', reason }`（✅源码 `dsh-session/lib/types/types.d.ts:166-209,331-339`；`dsh-agent-loop/README.md:75,128`）。
- 取消是**协作式**的：工具实现必须转发 `exec.signal`（✅源码 `dsh-tools/lib/types/index.d.ts:128` 注释）。
- `agent/error` 与 `turn/end.reason.kind === 'error'` 都要处理；headless 的做法是记录 `agent/error`，再用后续 `turn/end` 清除（✅源码 `dsh-headless/lib/index.js:334-338`）。

对 Gateway 的映射建议（与 `gateway-protocol.md` §4.5、§5.8 对齐）：

| 协议事实 | DSH 来源 |
|---|---|
| `message.status = queued` | `POST /messages` 受理后、`followup()` 之前/之后本地记账（DSH 无对应事件） |
| `message.status = delivered` | `agent/inbox/claimed`（`payload.turn`） |
| `conversation.message.delta`（累积全文） | `agent/assistant-stream` 的 `text-delta` 累加 |
| `conversation.message.completed` | `session/event` 的 `assistant/message`（`data.message.content` 全文 + `data.usage`） |
| `message.status = completed/failed` | `session/event` 的 `turn/end`（`reason.kind`） |
| `conversation.generation.cancelled` | 自己的取消受理 + `turn/end.reason.kind === 'aborted'` |
| `generations/current` | 自己的 generation 表 + `agent.status` |
| `generationId` | 自己在受理时生成，并绑定 `clientMessageId ↔ turn` |

---

## 4. 从 Session 日志读历史

### 4.1 日志事件的外层结构

```ts
type SessionEvent<T> = {
  type: T
  seq: SessionSeq            // 运行时是 number，从 0 连续
  time: number               // Unix epoch ms
  data: SessionEventMap[T]
  ignorable?: true           // 只有可安全跳过的插件记录才带
} & (surface 事件 ? { surfaceOp: SurfaceOp; sourceEventSeqs?: SessionSeq[] } : {})
```

（✅源码 `dsh-session/lib/types/types.d.ts:490-513`；`SurfaceEventType` 在 443 行：`system/message | developer/message | user/message | assistant/message | tool/result`。）

`SurfaceOp`：

```ts
type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
```

（✅源码 459-463 行。`replace` 是压缩/替换，**历史分页不能把它当成新消息**。）

### 4.2 核心事件类型与 payload

（✅源码 `dsh-session/lib/types/types.d.ts:256-434`；插件扩展事件见各包声明）

| 事件 | payload | 是否模型可见 | 对 Gateway 的用途 |
|---|---|---|---|
| `turn/start` | `{ turn }` | 否 | 一轮开始；分页边界 |
| `turn/end` | `{ turn, reason }` | 否 | 一轮结束；`reason.kind` → completed/aborted/error/blocked/max-tokens/interrupted/forked |
| `step/start` / `step/end` | `{ turn, step }` | 否 | 一次模型调用+工具执行 |
| `user/message` | `UserMessage`（`id`,`role:'user'`,`content`,`source`） | ✅ | 用户消息 / 注入上下文 |
| `assistant/message` | `{ turn, step, message: AssistantMessage, stream, usage?, interrupted? }` | ✅ | 助手消息；`content` 是 `ContentBlock[]` |
| `assistant/attempt` | `{ turn, step, stream }` | 否 | 失败/被取消/重试的模型尝试（不产生消息） |
| `tool/call` | `{ turn, step, callId, name, arguments }`（arguments 是原始 JSON 字符串） | 否（但 tool/result 可见） | 工具请求；与结果按 `callId` 配对 |
| `tool/result` | `{ turn, step, message: ToolResultMessage, error?, meta? }` | ✅ | 工具结果；`message.content` + `message.toolCallId` + `isError` |
| `developer/message` | `{ turn, step, message, headerSeq? }` | ✅（工具增删） | 一般不展示给 App |
| `system/message` | `{ turn, step, message: SystemMessage }` | ✅ | 系统提示词（surface 节点 0） |
| `request/header` | `{ header, reason, startsSeries? }` | 否 | 重建请求；`header.config` 有 provider/model/effort |
| `request/context` | `{ provider, model, contextWindow?, systemPromptUpdate? }` | 否 | 路由元数据 |
| `agent/inbox/spliced` | `{ target, start, removedCount?, inserted, outcome? }` | 否 | 队列变更（durable） |
| `session/end-seed` | `{ inherited?: true }` | 否 | fork 切点 |

**插件扩展事件**（会出现在同一个 `session/event` 流里，按需处理/忽略）：

| 事件 | 声明位置 | 说明 |
|---|---|---|
| `model/selection` | `dsh-api-session-controller/lib/types/types.d.ts:36` | 用户切换模型的 durable 记录（payload 同 `ModelSelection`） |
| `agent-preset/selected` | `dsh-agent-preset-registry`（`lib/index.js:48-52` 的 projection 读取） | 会话绑定 preset |
| `working-directory/change` | `dsh-working-directory` | cwd 变更 |
| `sandbox/mode` / `approval/*` / `permission/preset` | `dsh-sandbox-policy`、`dsh-user-approval`、`dsh-permission-presets` | 权限相关（Web profile 挂载） |
| `session/title` / `todo/write` / `job/*` / `command/*` | `dsh-session-title*`、`dsh-tool-todo`、`dsh-jobs-local`、`dsh-commands` | 标题、待办、后台任务、命令 |

> 完整合并清单可以从 typert 生成物里读到（`dsh-api-session-controller/lib/typert.host.js` 的 `declaration` 字符串，含 50+ 事件），但**以各包源码声明为准**（合并清单是生成物）。

### 4.3 读取历史的三条路径

| 路径 | API | 优点 | 限制 | 来源 |
|---|---|---|---|---|
| A. 活会话对象 | `session.deriveMessages()` | 最快、已缓存、自动应用 message projection | 只有 live session；返回模型可见消息（含 system/developer） | ✅源码 `dsh-session/lib/types/index.d.ts:329-347` |
| B. 统一查询 | `ctx.sessionQuery.readSession(id)` / `listEvents(id)` / `readSurface(id)` | 冷热统一；不需要激活 agent；返回 detached clone | `readSession` 返回**整份日志**（无分页参数）；`listEvents` 只有轻量元数据 | ✅源码 `dsh-session-query/lib/types/index.d.ts:74,111,127` |
| C. 上层控制器 | `ctx.sessionController.page(request, signal)` / `follow(request, signal)` | 已实现 Turn 对齐分页、opening 快照、assistant 流、幂等 | 仅 web profile；是 `TypertRemoteService`，直接调用的副作用待验证 | ✅源码 `dsh-api-session-controller/lib/types/index.d.ts:197-215` |

**已废弃**：`session.eventAt()` / `snapshotEvents()` / `ownEvents()` 明确标注“new production calls are prohibited”（✅源码 `dsh-session/lib/types/index.d.ts:206-231`）。headless 里仍在用 `eventAt` 属于历史遗留（`dsh-headless/lib/index.js:112-133`），**新代码不要学**。

### 4.4 投影成 user / assistant / tool 消息

冷日志（`SessionEvent[]`）→ App 时间线的投影函数。注意：

- 只取 `surfaceOp === 'append'` 的 surface 事件（replace 副本属于“模型可见”，不是“用户看到过”的历史；✅源码 `dsh-session/lib/types/surface.d.ts:52-66` 对 `isAppendSurfaceEvent` 的说明）。
- `tool/call` 不是 surface 事件，但它是工具卡片的“请求”侧；与 `tool/result` 用 `callId` 配对。
- 助手消息的 `content` 可能同时含 `reasoning` 与 `tool-call` 块；App 是否展示思考由产品决定。

```js
/**
 * @param {readonly any[]} events 按 seq 升序的完整日志（sessionQuery.readSession(id).events）
 * @returns {{ messages: any[], toolCalls: Map<string, any> }}
 */
function projectTranscript(events) {
  const messages = []
  const toolCalls = new Map()

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        if (event.surfaceOp !== 'append') break
        const m = event.data
        messages.push({
          id: String(m.id),
          seq: Number(event.seq),
          sender: 'user',
          text: m.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
          parts: toProtocolParts(m.content),
          timestamp: event.time,
          source: m.source,
        })
        break
      }
      case 'assistant/message': {
        if (event.surfaceOp !== 'append') break
        const m = event.data.message
        messages.push({
          id: String(m.id),
          seq: Number(event.seq),
          sender: 'assistant',
          text: m.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
          reasoning: m.content.filter((b) => b.type === 'reasoning').map((b) => b.text).join(''),
          parts: toProtocolParts(m.content),
          toolCalls: m.content.filter((b) => b.type === 'tool-call'),
          usage: event.data.usage,
          interrupted: event.data.interrupted === true,
          timestamp: event.time,
        })
        break
      }
      case 'tool/call': {
        toolCalls.set(String(event.data.callId), {
          callId: String(event.data.callId),
          name: event.data.name,
          arguments: event.data.arguments,   // 原始 JSON string
          turn: event.data.turn,
          step: event.data.step,
        })
        break
      }
      case 'tool/result': {
        const m = event.data.message
        messages.push({
          id: String(m.id),
          seq: Number(event.seq),
          sender: 'tool',
          toolCallId: String(m.toolCallId),
          isError: m.isError === true,
          parts: toProtocolParts(m.content),
          text: m.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
          meta: event.data.meta,
          error: event.data.error,
          timestamp: event.time,
        })
        break
      }
      case 'turn/start':
        messages.push({ id: `turn-${event.data.turn}`, kind: 'turn-start', turn: event.data.turn, timestamp: event.time })
        break
      case 'turn/end':
        messages.push({ id: `turn-${event.data.turn}-end`, kind: 'turn-end', turn: event.data.turn, reason: event.data.reason, timestamp: event.time })
        break
      default:
        break // system/message, developer/message, step/*, request/*, agent/inbox/* 一般不入 App 时间线
    }
  }

  return { messages, toolCalls }
}

/** ContentBlock[] → 协议的 parts（文本/附件）。image/file 需要自己的下载路由。 */
function toProtocolParts(content) {
  const parts = []
  for (const block of content) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') parts.push({ type: 'attachment', attachmentId: String(block.attachment.attachmentId), mediaType: block.attachment.mediaType, sizeBytes: block.attachment.bytes, filename: block.attachment.name })
    else if (block.type === 'file') parts.push({ type: 'attachment', attachmentId: String(block.attachment.attachmentId), mediaType: 'application/octet-stream', sizeBytes: block.attachment.bytes, filename: block.attachment.name })
  }
  return parts
}
```

### 4.5 历史分页建议

`sessionQuery.readSession` 是整份快照（✅源码 `dsh-session-query/lib/types/index.d.ts:69-74` 注释，返回 `SessionLogSnapshot`），没有 offset/limit。因此分页必须自己做，推荐两种方案：

**方案 1（推荐）：自己的时间线表 + DSH 快照对齐**

- 以 `conversationId ↔ sessionId` 建表，记录已投影到的 `seq`（`watermark`）。
- 读新事件：`sessionQuery.readSession(sessionId)` 取回后只投影 `seq > watermark` 的部分（或读者自行保存 offsets）。
- 分页用**本地表**做 cursor（协议要求不透明 cursor + `snapshotRevision`，见 `gateway-protocol.md` §5.5），不直接暴露 DSH seq。
- 优点：完全可控；工具调用/附件/思考都能自定义；可做“删除/占位”等协议语义。
- 代价：多一份派生存储（建议放在插件私有目录，§8）。

**方案 2：复用 `sessionController.page()`**

- 直接拿 Turn 对齐页（`SessionPageRequest` 有 `throughSeq`/`beforeSeq`/`maxMessages`/`turnWindow`，✅源码 `dsh-api-session-controller/lib/types/types.d.ts:467-537`）。
- 优点：逻辑现成，和 Web UI 一致。
- 风险：它是 `TypertRemoteService`，`inject` 含 `remoteAccess`、`fileUploads`（✅源码 `dsh-api-session-controller/lib/index.js:2917-2928`）。但直接调用时 `ctx.invocation` 为 undefined：`principalOf(undefined)` 返回 `undefined`（✅源码 `dsh-typert-protocol/lib/index.js:294-297`），方法内会把调用方当作 owner，不做 Remote 级拒绝。仍需 e2e 实测冷会话/并发（⚠️见 §11 的 U-03，仓库实现已在用）。

**方案 3：只用 `sessionQuery.readSurface()`**

- 返回当前模型 surface（已被 replace 压缩过），适合“当前上下文”展示，不适合“用户看过的完整时间线”。

**性能注意**：`readSession` 会 replay 校验并在冷路径用 prepared Session 缓存（默认 5 个，✅源码 `dsh-session-query/lib/types/config.d.ts:20`）。高频轮询会浪费 IO；应缓存快照并用 `session/event` 增量更新。

---

## 5. 注册模型工具（model-facing tools）

### 5.1 `ctx.tools` 精确 API

```ts
class ToolRuntime extends Service {
  register(definition: ToolDefinition): () => void        // index.d.ts:637
  restrict(filter: ToolRestriction): () => void           // :645
  guard(guard: ToolGuard): () => void                     // :656
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined   // :691
  schemas(scope?: ScopeKey): ToolSchema[]                 // :712
  executionMode(exec: ToolExecutionInput): ToolExecutionMode        // :724
  execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>   // :766
  presentAs(mode: ToolPresentationMode): () => void       // :610
}
```

- “Register globally or in the calling agent scope. Scoped tools shadow globals”（✅源码 `dsh-tools/lib/types/index.d.ts:631-637` 注释）。
- 注册即可见：schema 自动进入 system-prompt assembly（✅源码 `dsh-tools/README.md:30`）。
- 注销就是调用返回的 disposer；用 `ctx.effect(() => ctx.tools.register(def))` 让插件卸载时自动注销。

### 5.2 `ToolDefinition` 的字段

（✅源码 `dsh-tools/lib/types/index.d.ts:114-191`；`ToolSchema` 见 `dsh-llm/lib/types/types.d.ts:472-483`）

```ts
interface ToolDefinition extends ToolSchema {   // name/description/parameters 三个是 wire 字段
  output: {                                     // 必填：canonical 输出声明
    schema: JsonSchemaNode                      // 成功返回值的 JSON Schema
    render(args, value): ContentBlock[]         // 投影成模型可见内容
    presentationMeta?(args, value): JsonValue   // 可选：UI 卡片元数据（持久化到 tool/result.meta）
  }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>   // 只返回 canonical JSON 值
  projectContent?(exec, result): ContentBlock[] | undefined        // 执行期内容（post-execute 之前）
  finalizeContent?(exec, result): ContentBlock[] | undefined       // 最后一道内容变换
  timeoutMs?: number                       // 仅声明；实际由 dsh-tool-call-timeout-policy 执行
  isConcurrencySafe?(args): boolean        // 只有显式 true 才允许并行
  presentCall?(args): ToolCallView | undefined
  presentResult?(args, result): ToolResultView | undefined
}
```

`parameters` 是 **JSON Schema 对象**（`Record<string, unknown>`），直接写到模型请求里。`description` 会进入工具目录，必须写清楚（参考 `agent-experience` skill，但不在本报告范围）。

### 5.3 两种定义方式

**方式 A：`defineTool`（官方 DSL；仅当 `@deepseek-ai/dsh-tools` 能被解析时可用）**

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.effect(() => ctx.tools.register(defineTool({
  name: 'read_file',
  description: 'Read a file from disk.',
  parameters: {
    path: { type: 'string', required: true, description: 'Absolute file path' },
    offset: { type: 'number' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
  },
})))
```

（✅源码 `dsh-tools/README.md:38-62`；DSL 类型在 `dsh-tools/lib/types/schema.d.ts:61-84,178-248`。`defineTool` 会做参数校验、输出校验、类型推断。）

⚠️注意：在本仓库形态下 `import '@deepseek-ai/dsh-tools'` 会 `MODULE_NOT_FOUND`（§0.3 坑 1），所以**默认选方式 B**；方式 A 列为“依赖可解析时”的备选。

**方式 B：手写 `ToolDefinition`（零 harness import，本项目更稳）**

```js
const definition = {
  name: 'android_device_run',
  description: [
    'Run one capability on the paired Android device.',
    'Arguments follow the device-published capability schema.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['capabilityId', 'capabilityVersion', 'parameters'],
    properties: {
      capabilityId: { type: 'string', minLength: 1 },
      capabilityVersion: { type: 'string', minLength: 1 },
      parameters: { type: 'object', additionalProperties: true },
    },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },   // 手写定义用原生 JSON Schema（不要用 DSL 的 type:'json'）
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  isConcurrencySafe: () => false,
  async execute(args, exec) {
    assertValidArgs(args)                       // 自己校验（注册表不校验，见下）
    return await runDeviceCapability(ctx, args, exec)   // §5.6
  },
}
ctx.effect(() => ctx.tools.register(definition))
```

⚠️待验证：注册表对 `arguments` 的契约是“parsed arguments（tools validate their own schema）”（✅源码 `dsh-tools/lib/types/index.d.ts:226` 注释），即**`ToolRuntime.execute` 不做 schema 校验**——校验由 `defineTool` 包装。手写定义必须自己校验，否则非法参数会直达 `execute`。

### 5.4 执行上下文 `ToolRunContext`

```ts
interface ToolRunContext extends ToolExecution {
  agent?: Agent                              // 谁在调用（由 loop 设置）
  signal: AbortSignal                        // 必须转发给 async 工作
  deferContext(context: UserMessage): void   // 把额外上下文挂到本次结果之后
  concludeTurn(): void                       // 成功结果后结束当前 turn
}
```

（✅源码 `dsh-tools/lib/types/index.d.ts:305-322`；`ToolExecutionInput.agent` 在 229 行，`signal` 在 241 行。）

- **取消**：body 必须观察 `exec.signal`；取消前未进入 body 记 `ABORTED_BEFORE_DISPATCH`，进入后成功结果被替换为 `ABORTED`（✅源码 `README.md:126`）。
- **额外上下文**：设备返回的图片/运行日志想进模型上下文，用 `exec.deferContext({...})`（loop 在 `tool/result` 之后追加；✅源码 305-312 行注释）。
- **结束 turn**：`exec.concludeTurn()` 让 loop 在本批成功结果提交后结束 turn（例如“任务完成”类工具）。
- **超时**：`timeoutMs` 只是声明，真正执行靠 `dsh-tool-call-timeout-policy` 包裹（✅源码 151-158 行注释；web profile 已挂 `timeout-policy`，✅源码 `dsh-base/cordis.patch.yml:408-410`）。

### 5.5 工具返回图片 / 附件

图片必须是**durable attachment ref**，不能塞 base64。官方 `read_image` 工具就是范例（✅源码 `dsh-tool-fs/lib/index.js:966-974,1009-1057`）：

```js
/** 工具 execute 的返回部分：先把字节存成 DSH 附件，再返回 canonical JSON */
async function saveScreenshot(ctx, data, mediaType) {
  const ref = await ctx.attachments.saveImage({
    data,                       // Uint8Array
    mediaType,                  // 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    name: 'screenshot.png',
  })
  return {
    image: {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    },
  }
}

// 对应 ToolDefinition.output：schema 描述上面的返回对象，render 投影为模型可见块
// output: {
//   schema: { /* { image: { attachmentId, mediaType, bytes, width, height, name? } } */ },
//   render: (_args, value) => [
//     { type: 'text', text: `screenshot ${value.image.width}x${value.image.height}` },
//     { type: 'image', attachment: value.image },
//   ],
// }
```

只能返回**一张图**吗？不是：`render` 可以返回多个 `image` 块，但受路由的图片输入能力限制（provider 是否支持多图）；`dsh-tool-fs` 里会检查 `assertImageCapableRoute`（✅源码 `dsh-tool-fs/lib/index.js:1009-1013`）。为稳妥，设备截图建议一次一张。

通用文件（PDF、日志、录音）用 `saveFile`/`saveFileStream`，结果为 `FileBlock`（模型只看到一行路径提示，见 §7）：

```js
async function saveLogcat(ctx, bytes) {
  const fileRef = await ctx.attachments.saveFile({ data: bytes, name: 'logcat.txt' })
  return { file: { attachmentId: fileRef.attachmentId, name: fileRef.name, bytes: fileRef.bytes } }
}
// output.render: [ { type: 'file', attachment: value.file } ]
```

### 5.6 设备能力工具（与 `gateway-protocol.md` §8.7 对齐）

协议要求宿主侧实现“先 enqueue 再等 claim+终态”，典型代码：

```js
async function runDeviceCapability(ctx, args, exec) {
  const gateway = ctx.get('androidGateway')          // 自己的服务（用 ctx.provide 注册）
  const request = await gateway.enqueueDeviceRequest({
    capabilityId: args.capabilityId,
    capabilityVersion: args.capabilityVersion,
    parameters: args.parameters,
  }, { signal: exec.signal, timeoutMs: args.timeoutMs ?? 60_000 })

  try {
    const outcome = await gateway.waitForOutcome(request.requestId, { signal: exec.signal })
    if (outcome.kind === 'ok') return { outcome: 'ok', data: outcome.data }
    if (outcome.kind === 'timeout') return { outcome: 'outcome_unknown', code: 'DEVICE_TIMEOUT' }
    if (outcome.kind === 'offline') return { outcome: 'outcome_unknown', code: 'DEVICE_OFFLINE' }
    return { outcome: 'denied', reason: outcome.reason }
  } finally {
    // 工具结果确认后再 acknowledgeResult（协议 §8.5）
    await gateway.acknowledgeResult(request.requestId).catch(() => {})
  }
}
```

要点：

- 工具入参只放 `{capabilityId, capabilityVersion, parameters}`；`deviceId/pairingGeneration/grantRevision` 从**可信上下文**取，不能让模型填（否则越权）。
- 等待期间必须响应 `exec.signal`（用户取消/超时）。
- 失败要返回**结构化结果**而不是 throw：throw 会变成 `Error: <message>`，丢结构（✅源码 `dsh-tools/README.md:215`）。
- 结果包含图片时，先 `ctx.attachments.saveImage` 再在 `render` 里放 `image` 块（同 §5.5）。

### 5.7 权限 / 沙箱

工具管线（✅源码 `dsh-tools/README.md:109,141`）：

```text
tools/pre-execute（可 allow/deny/ask）
  → ctx.tools.guard()（单调拒绝，晚注册也不能翻案）
  → tools/execute（wrap：超时、重试、指标）
  → tools/post-execute（改内容/阻断/附加 context）
  → finalizeContent
  → tools/result（只观察）
```

- `ask` 决策走 `ctx.get('approval')`，没有 ApprovalService 时降级为 deny（✅源码 `dsh-tools/lib/types/index.d.ts:817-828` 注释；web profile 挂 `dsh-user-approval`）。
- `restrict(filter)` 只能**减少** agent 可见的全局工具；对自有 agent 作用域可用 `agentCtx.tools.restrict(...)` 隐藏危险工具（✅源码 638-656 行）。
- 沙箱（`dsh-sandbox-policy`、`dsh-bash-sandbox`、`dsh-fs-sandbox`）只约束**这些包自己的工具**；插件自研工具的权限边界要靠自己的 `guard`/`pre-execute` 或审批实现。
- 对 Android Gateway 的工具，建议：
  1. 在 `agentCtx` 上 `restrict` 掉不需要的 host 工具（如 `bash`）；
  2. 设备高危能力走 `ask`（App 弹审批卡片，协议 §5.9）；
  3. `guard` 做“设备离线/会话不匹配”之类的硬拒绝。

### 5.8 动态注册与注销

```js
// 在 agent 作用域注册（只对该 agent 可见，agent 销毁自动清理）
function installDeviceTools(agentCtx, deviceId) {
  const dispose = agentCtx.tools.register(buildDeviceTool(deviceId))
  // 若还要在插件卸载时兜底清理（双保险，符合 practices.md:8）
  pluginOwnedDisposers.set(deviceId, dispose)
  return dispose
}

// 注销
dispose()                       // 幂等；重复调用无副作用（Cordis disposer 语义）
```

**作用域选择**：

| 需求 | 注册位置 |
|---|---|
| 所有会话共享（如 `gateway_status`） | `ctx.tools.register()`（host 全局） |
| 只给某个会话/设备（如 `android_device_run`） | `agent.ctx.tools.register()` 或 `setup(agentCtx)` 内 |
| 需要随 preset 组合变化 | 由 preset 行注册（不在本项目控制范围） |

⚠️待验证：在 Web profile（工具由 preset 提供）下，**host 全局注册的工具是否对所有 preset agent 可见**。从机制上：`restrict` 只过滤“继承的全局层”，且 preset 未声明 restrict（`dsh-web-app/presets/*.patch.yml` 中未见 restrict，✅源码 grep），因此**推断可见**；但必须用一个 5 行 demo 验证（见 §11 的 U-01）。

---

## 6. HTTP 服务：两条路线

### 6.1 路线 A：挂到 `ctx.webServer`（共享 GUI 端口）

**能力**（✅源码 `dsh-host-webserver/lib/types/index.d.ts`）：

```ts
interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string                       // 绝对路径，无尾斜杠
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>   // :39
}
register(route: WebRoute): () => void                 // :174
registerUpgrade(route: WebUpgradeRoute): () => void   // :181（WebSocket 升级）
registerFallback(handler): () => void                 // :190（唯一 fallback 座位）
get port(): number | undefined                        // :152
get host(): string                                    // :154
get protocol(): 'http:' | 'https:'                    // :160
getOrigin(): string                                   // :167
```

- **原始 req/res**：路由 handler 直接拿到 `node:http` 的 `IncomingMessage` / `ServerResponse`，没有任何 body 解析（✅源码 `dsh-host-webserver/lib/index.js:380-391`：`await route.handler(req, res)`）。因此：
  - 原始 body：`for await (const chunk of req)`；
  - headers：`req.headers`（注意 node 会小写化 key）；
  - 流式响应：自己 `writeHead` + `write` + `end`。
- **SSE 长连接**：明确支持。`WebRoute.handler` 的注释写着“may hold the response open, e.g. SSE”（✅源码 index.d.ts:38）。真实范例是 `dsh-client-hmr` 的 `/plugins/events`（✅源码 `dsh-client-hmr/lib/index.js:114-160`：`text/event-stream`、`: connected`、连接集合、卸载时 `destroy()`）。
- **匹配顺序**：exact 全表 → 最长 prefix → fallback（✅源码 README:61；`lib/index.js:495+` 的 `match`）。
- **重复注册**同一 `(kind, path)` 会抛错（✅源码 index.d.ts:168-173 注释）。
- **压缩**：webserver 可配 `compression: 'gzip'`，但 SSE 不被压缩（✅源码 README:41）。Web profile 确实开了 gzip（✅源码 `dsh-web-app/cordis.patch.yml:179-191`）。
- **没有全局鉴权**：webserver 本身不做认证/来源校验（✅源码 README:129-131：“No server-wide authentication or origin policy”），路由 owner 自己负责。可复用 `ctx.connection.requestRejection(req)` 做 Host/Origin 信任检查（✅源码 `dsh-client-connection/lib/types/rpc-host.d.ts:37`；用法见 `dsh-host-open-in-app/lib/index.js:1262-1270`）。

**限制（对本项目很关键）**：

| # | 限制 | 依据 |
|---|---|---|
| A1 | 一个 realm 只能有一个 `webServer` 服务；重复 provide 会抛“already provided” | ✅源码 `cordis/lib/types/reflect.d.ts:35-44` |
| A2 | **拒绝绑定 wildcard（0.0.0.0 / ::）**；只能绑具体本机接口 IP 或回环 | ✅源码 `dsh-host-webserver/README.md:39`；`lib/types/index.d.ts:60-69` |
| A3 | 端口/host 由 webserver 行统一决定（web profile 来自 `webStartup`），插件无法单独指定 | ✅源码 `dsh-web-app/cordis.patch.yml:179-191` |
| A4 | 与 Web GUI 共享端口和生命周期；GUI 关闭 → gateway 断 | ✅推理自 A1/A3 |
| A5 | 没有 TLS（除非整个 webserver 开 `tls`） | ✅源码 index.d.ts:73-81 |
| A6 | 路由前缀必须避开 `/api`（Connection 独占，✅源码 `dsh-client-connection/lib/types/index.d.ts:20`） | ✅源码 |

**适用场景**：Gateway 只在“DSH GUI 同机 + App 走 adb reverse/本机回环”时够用；要给局域网设备用，A2 直接卡死。

### 6.2 路线 B：插件自建 `node:http` 服务器（推荐）

```js
import { createServer } from 'node:http'

ctx.effect(async () => {
  /** @type {Set<import('node:http').ServerResponse>} */
  const sseClients = new Set()
  const heartbeat = setInterval(() => {
    for (const res of sseClients) { try { res.write(': ping\n\n') } catch {} }
  }, config.heartbeatMs)
  heartbeat.unref?.()

  const server = createServer((req, res) => { void handleRequest(req, res, sseClients) })

  // 监听失败 → 本 effect 的 Promise reject → 插件激活失败（fail loud）
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      ctx.logger.info('android-gateway: listening on %s:%d', config.host, config.port)
      resolve()
    })
  })

  let closed = false
  return async () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    for (const res of sseClients) { try { res.destroy() } catch {} }
    sseClients.clear()
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(() => resolve()))
  }
}, 'android-gateway: http server')
```

要点：

- **生命周期**：`ctx.effect` 的 disposer 可以是 async，Cordis 卸载会 await（✅源码 `cordis/lib/types/fiber.d.ts:43-49,148-159`）。必须 `closeAllConnections()` + 销毁所有 SSE 响应，否则 `server.close()` 永远不返回（长连接不会自己断）。
- **端口配置**：放 `Config`（用户可在 `cordis.patch.yml` 改，升级不丢；✅源码 `practices.md:22`）。端口冲突时 `listen` 报 `EADDRINUSE`，应 fail loud。
- **绑定地址**：自己起 server 可以绑 `0.0.0.0`（Web profile 的 webserver 不行），但**必须**加认证（协议 §2 的设备会话 + 九 header 签名），否则等于把 Agent 暴露给整个局域网。
- **TLS**：`node:https` 需要证书；协议 §1 要求 HTTPS 才可核验身份，局域网场景建议至少自签 + 首次 TOFU 固定 `tlsSpkiSha256`（与协议协商字段对齐）。
- **压缩**：SSE 本来就不该 gzip；JSON 响应可自行压缩。
- **可观测性**：`getOrigin()` 不可用（没有 webServer），自己拼 `http://host:port` 并写日志；如果 `DSH_WEB_URL` 存在可打印给用户。

### 6.3 两条路线对照

| 维度 | A：`ctx.webServer` | B：自建 `node:http` |
|---|---|---|
| 端口 | 与 GUI 共用，不可选 | 独立端口，可配置 |
| 绑定地址 | 仅具体本机 IP/回环，禁 wildcard | 任意（含 0.0.0.0） |
| TLS | 跟随整个 webserver | 自己决定 |
| SSE | 支持（有范例） | 支持 |
| 原始 body/headers | ✅ | ✅ |
| 鉴权 | 自己做（可借 `connection.requestRejection`） | 自己做 |
| 生命周期 | 随 GUI；服务卸载即断 | 随插件 effect；可控 |
| 与 GUI 冲突 | 路由前缀需避让 | 无 |
| 适合 | 本机调试、adb reverse、单机 Demo | 真机局域网、生产 |

**结论（通用建议）**：若目标是“App 直连局域网”，以 **B** 为主；A 适合“App 通过 adb reverse / 同机回环访问”。本仓库现状选 A（见 §6.6）。

### 6.6 与本仓库当前实现的关系（已落地选择 A）

仓库现有实现 `src/index.ts` 选择的是 **A**：

```ts
export const inject = ["webServer"] as const;
// apply(): 挂载 /open-android-intelligence/v2 前缀路由，复用 GUI 的 HTTP 服务器
```

（✅源码 `src/index.ts:18-21,71-96`。）

这个选择在本产品语境下**是合理且自洽的**，原因：

1. App 与 DSH GUI 同一台机器：通过 `adb reverse tcp:<GUI端口> tcp:<GUI端口>` 或同机回环访问，不需要 wildcard 绑定；
2. 复用 GUI 的 TLS/端口生命周期，部署简单；
3. 路由以 `/open-android-intelligence/v2` 前缀注册，与 `/api`、`/plugins/events` 不冲突：webserver 匹配顺序是“exact 全表 → 最长 prefix → fallback”（✅源码 `dsh-host-webserver/README.md:61`；`lib/index.js:380-391`）。

代价与注意：

- Gateway 只在 **web profile** 存在（`inject: ['webServer']`）；headless/sdk profile 不会加载——这是产品预期，但要在文档里写明；
- App 的 base URL 必须等于 GUI 的 origin（`DSH_WEB_URL`），端口随 `--port` 变化；
- 真机“局域网直连、不走 adb”需要另开 B 方案或改 DSH 启动参数（`--host <LAN IP>`），而 `--host 0.0.0.0` 会被 webserver 拒绝（A2）；
- 需要自己做认证（仓库已实现 `RequestAuthenticator`，`src/auth/authenticator.ts`）。

> 因此：**报告 §6.1 的 A 是“现状”，§6.2 的 B 是“局域网直连的备选”**。两者对 DSH 适配层（§2/§3/§4/§7）没有影响。

### 6.4 处理请求的公共骨架（含 SSE 与上限）

```js
const MAX_BODY_BYTES = 2 * 1024 * 1024      // 协议正文有大小上限；附件走流式上传

async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (total === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

function openSse(req, res, clients) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  clients.add(res)
  req.on('close', () => clients.delete(res))
}

function sseSend(res, eventId, eventType, data) {
  res.write(`id: ${eventId}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
}
```

（响应头与心跳写法对齐协议 §4.1 与 `dsh-client-hmr/lib/index.js:114-121`。）

### 6.5 一个必须面对的现实

`dsh web` 启动参数里 `--host` 是 **webserver 的绑定地址**，默认 `127.0.0.1`（✅源码 `dsh-web-app/cordis.patch.yml:179-191` 的 fallback）。Android 真机要连 PC，要么：

1. 插件自建 server 绑 `0.0.0.0`（推荐，配 token/签名）；
2. `adb reverse tcp:8790 tcp:8790`，App 连 `127.0.0.1:8790`（插件仍绑回环，最安全）；
3. 用 `--host <LAN IP>` 让 GUI 的 webserver 绑 LAN —— 但那样 GUI 也暴露，且 webserver 仍拒绝 wildcard（A2）。

**建议**：默认 B + `127.0.0.1`；文档里给出 `adb reverse` 与“显式开启 LAN”两个开关，LAN 模式强制要求认证配置，不配就拒绝启动。

---

## 7. 附件

### 7.1 `ctx.attachments`（`AttachmentStore` 抽象）

```ts
abstract class AttachmentStore extends Service {
  abstract readonly imageLimits: ImageAttachmentLimits                 // :21
  abstract validateImage(input: SaveImageAttachment): Promise<void>     // :28
  saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>  // :43
  admitPromptContent(content: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]>  // :51
  admitEncodedFile(input: EncodedFileAttachment): Promise<FileAttachmentRef>   // :58
  isAttachmentError(error: unknown): error is AttachmentError          // :64
  abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>  // :73
  abstract readImage(ref, signal?): Promise<StoredImageAttachment>     // :81
  imageHostPath(ref): string | undefined                               // :88
  saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef>      // :97
  saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef>  // :105
  readFileStream(ref, signal?): AsyncIterable<Uint8Array>              // :114
  fileHostPath(ref): string | undefined                                // :121
  readImageRequest(ref, target, signal?): Promise<RequestImageAttachment>  // :129
}
```

（✅源码 `dsh-attachment/lib/types/index.d.ts`，行号如注。）

数据类型（✅源码 `dsh-attachment/lib/types/types.d.ts`）：

```ts
interface ImageAttachmentRef {
  attachmentId: AttachmentId      // 不透明 id（内容寻址）
  mediaType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif'
  bytes: number; width: number; height: number
  name?: string
  originalDimensions?: { width: number; height: number }
}
interface FileAttachmentRef { attachmentId: AttachmentId; name: string; bytes: number }
interface SaveFileAttachment { data: Uint8Array; name?: string }
interface SaveFileStreamAttachment { data: AsyncIterable<Uint8Array>; signal?: AbortSignal; name?: string }
```

### 7.2 大小与格式限制（`dsh-attachment-local` 默认值）

（✅源码 `dsh-attachment-local/README.md:38-49`）

| 配置 | 默认 | 含义 |
|---|---:|---|
| `maxImageBytes` | 20 MiB | 单张图片源字节上限 |
| `maxImagesPerMessage` | 20 | 单条消息图片数 |
| `maxMessageImageBytes` | 200 MiB | 单条消息图片总字节 |
| `maxImagePixels` | 64,000,000 | 源宽×高 |
| `maxImageDimension` | 8192 | 单边像素 |
| `normalizedImageMaxPixels` | 2048×2048 | 归一化总像素预算 |
| `normalizedImageMaxDimension` | 8192 | 归一化长边 |
| `normalizedImageMaxBytes` | 4 MiB | 归一化目标字节（质量阶梯取最小） |

- **文件无限制**：任何类型、任意大小，逐字节原样存储（✅源码 README:40,71,97 — `saveFile`/`saveFileStream` 不做 admission 限制）。
- **图片会归一化**：EXIF 方向应用、去元数据/色彩配置、透明用 WebP、不透明用 JPEG、GIF 只保留第一帧（✅源码 README:59,86,137）。
- **永不自动删除**：没有 GC（✅源码 README:119,135）。

### 7.3 存储位置与读取

```text
<DSH_HOME>/attachments/v1/objects/<sha256-prefix>/<sha256>        # 归一化图片
<DSH_HOME>/attachments/v1/file-objects/<digest-prefix>/<digest>   # 文件内容
<DSH_HOME>/attachments/v1/files/<digest-prefix>/<digest>/<name>   # 文件硬链接（只读）
<DSH_HOME>/cache/attachments/request-images/                      # 路由请求版本缓存
```

（✅源码 `dsh-attachment-local/README.md:84,88,90`；读写都做 digest/长度校验，损坏会 fail closed。）

- 读取原图：`ctx.attachments.readImage(ref)` → `{ ref, data }`。
- 读取文件流：`ctx.attachments.readFileStream(ref)` → `AsyncIterable<Uint8Array>`。
- 生成模型请求版本：`readImageRequest(ref, { width, height, maxBytes })`（一般不用手调，provider 适配层会做）。

### 7.4 App 上传字节流 → DSH 附件 → 交给 agent

协议是三步上传（`gateway-protocol.md` §7.1）：`attachment.create` → `PUT /attachments/{id}/content`（流式）→ `attachment.commit`。第三步拿到 `verified` 后，**把字节写成 DSH 附件**，再把 ref 放进用户消息：

```js
// 1) 上传时（流式落盘到 DSH 附件；也可以先落临时文件再二次读）
async function storeUploadedFile(ctx, req, filename) {
  const ref = await ctx.attachments.saveFileStream({
    data: req,                        // IncomingMessage 是 AsyncIterable<Uint8Array>
    name: filename,
    signal: AbortSignal.timeout(10 * 60 * 1000),
  })
  return ref   // { attachmentId, name, bytes }
}

// 2) 发消息时把 ref 变成 ContentBlock
function toUserContent({ text, imageRefs = [], fileRefs = [] }) {
  return [
    ...imageRefs.map((ref) => ({ type: 'image', attachment: ref })),
    ...fileRefs.map((ref) => ({ type: 'file', attachment: ref })),
    { type: 'text', text },
  ]
}

// 3) 构成 UserMessage 交给 followup
agent.followup({
  id: `msg_${crypto.randomUUID()}`,
  role: 'user',
  content: toUserContent({ text: '看看这张截图', imageRefs: [savedImageRef] }),
  source: { kind: 'user' },
})
```

**关键结论**：✅ 能。App 上传的字节流可以保存成 DSH 附件并让 agent 读取：

- 图片：`saveImage`（校验/归一化）→ `ImageBlock`；模型直接看图。
- 其它文件：`saveFile` / `saveFileStream` → `FileBlock`；模型**看不到字节**，只看到一行“文件名/大小/只读路径”，它需要用 `read_file`/`bash` 等文件工具按路径读取（✅源码 `dsh-attachment/README.md:40,105`）。因此若 App 上传的是 PDF/日志，**必须确保 agent 有读文件工具**（Web profile 下这些工具在 preset 里，见 §0.3/§9.2）。

### 7.5 让 App 下载 DSH 产生的内容

反过来（模型生成的图片/文件回传 App）需要自己的下载路由：

```js
// GET /open-android-intelligence/v2/attachments/{id}/content
async function sendAttachment(ctx, res, attachmentId) {
  const ref = await lookupRefById(attachmentId)     // 自己的映射表：attachmentId → Image/FileAttachmentRef
  if (ref.kind === 'image') {
    const stored = await ctx.attachments.readImage(ref.value)
    res.writeHead(200, { 'content-type': ref.value.mediaType, 'content-length': stored.data.byteLength })
    res.end(Buffer.from(stored.data))
  } else {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    for await (const chunk of ctx.attachments.readFileStream(ref.value)) res.write(Buffer.from(chunk))
    res.end()
  }
}
```

限制：

- `attachmentId` 是**内容寻址的不透明 id**，没有“会话归属”内建校验；必须以“该 ref 出现在本会话日志里”为准做授权（参考 `dsh-api-session-controller` 的 `attachment()` 授权逻辑，✅源码 `index.d.ts:181-186`）。
- 图片已被归一化（尺寸/格式变化），App 看到的字节与上传时**不同**；协议里的 `sha256` 应对“归一化后字节”计算，否则校验会失败。
- 存储是本机的（`DSH_HOME`），多机部署需要另做同步（✅源码 `dsh-attachment-local/README.md:55`）。

---

## 8. 持久化：插件私有数据放哪

### 8.1 `DSH_HOME` 的解析规则

`resolveDshHome()` 的优先级（✅源码 `dsh-home-paths/README.md:25-40`）：

```text
显式配置路径  >  $DSH_HOME  >  ~/.dsh
```

空白/纯空格的 `$DSH_HOME` 视为未设置（避免把 home 解析成 cwd）。`dshHomePath(...segments)` 拆到 home 下的子路径，`dshCachePath(...segments)` 拆到 `<home>/cache/...`。二者返回绝对路径、不创建目录。

```js
// 零依赖版本（语义与 resolveDshHome 相同：显式 > $DSH_HOME > ~/.dsh）
function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured)
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env)
  return path.join(os.homedir(), '.dsh')
}

const home = resolveDshHome()                       // /home/djbd/.dsh-cline
const dataDir = path.join(home, 'android-gateway')  // <home>/android-gateway
const cacheDir = path.join(home, 'cache', 'android-gateway')
```

⚠️注意：`import ... from '@deepseek-ai/dsh-home-paths'` 在本仓库形态下同样 `MODULE_NOT_FOUND`（§0.3 坑 1）。语义来源：✅源码 `dsh-home-paths/README.md:25-40`；优先使用 `ctx.profileContext.home`（见 8.2），它由 launcher 直接给出，不需要猜。

### 8.2 权威入口：`ctx.profileContext`

```ts
interface ProfileContext {
  readonly name: string          // 'web'
  readonly dir: string           // /home/djbd/.dsh-cline/profiles/web
  readonly patchPath: string     // .../profiles/web/cordis.patch.yml
  readonly installAnchor: string // 安装锚点（运行时包根）
  readonly cwd: string
  readonly home: string          // /home/djbd/.dsh-cline
  readonly startedBundles: readonly string[]
  readonly overlays: readonly PatchOptions[]
  readonly telemetryDisabledEnv: string | undefined
}
```

（✅源码 `dsh-app-boot/lib/types/profile-context.d.ts:10-31`；只在“由 dsh launcher 启动的 profile”中存在。）

```js
const profile = ctx.get('profileContext')
const dataDir = profile === undefined
  ? path.join(os.homedir(), '.dsh', 'android-gateway')   // 兜底（SDK/嵌入场景）
  : path.join(profile.home, 'android-gateway')
```

### 8.3 profile 目录与 `$DSH_HOME` 的关系

```text
$DSH_HOME/
  cordis.patch.yml                 # home 级 patch 层（覆盖所有 profile）
  profiles/
    node_modules/                  # 共享依赖树
    web/
      cordis.yml                   # 根 entry 列表（空）
      cordis.patch.yml             # profile 级 patch（用户可改）
      package.json                 # dsh.profile.bundles
  sessions/                        # dsh-session-persistence-jsonl 的 root
  storages/                        # dsh-storage-json 的 root
  attachments/                     # dsh-attachment-local
  cache/                            # dshCachePath
```

- profile 目录解析：`resolveProfileDir(name, home)` → `$DSH_HOME/profiles/<name>`（✅源码 `dsh-app-boot/lib/index.js:507,546`）。
- home 级 patch：`$DSH_HOME/cordis.patch.yml`（✅源码 `dsh/lib/profile-boot-*.js:115-117`）。
- 会话文件布局：`<root>/--<normalized-cwd>--/<encoded-id>/session.v4.jsonl(.zstd)`（当前格式 v4；✅源码 `dsh-session-persistence-jsonl/README.md:54-70` 与 `SESSION_FORMAT_VERSION = 4`）。

### 8.4 `ctx.storage` / `ctx.storageDomain`（可选）

若不想自己管文件，可用存储服务：

- `ctx.storage`：后端注册表（`dsh-storage`）。
- `ctx.storageDomain`：带 schema 的 domain 数据面（`dsh-storage-domain`，web profile 挂的是 JSON 后端，root=`$DSH_HOME/storages`）。
- 适合存“键值型、有 schema、需要原子写”的小数据（如设备注册、幂等账本）；序列化与版本由 domain 管。
- 不适合存大二进制（用 attachments）或需要复杂查询的表（自己接 SQLite 更直接）。

（✅源码 `dsh-storage/README.md:30-65`；`dsh-base/cordis.patch.yml:179-193`。）

### 8.5 推荐的数据划分

| 数据 | 存哪 | 理由 |
|---|---|---|
| 会话/消息正文 | **DSH session log**（唯一真源） | 模型可见、可 replay、可 fork（✅ `practices.md:7`） |
| 图片/文件字节 | `ctx.attachments`（`$DSH_HOME/attachments`） | 内容寻址、去重、校验、模型可读 |
| 协议侧账号/设备/配对/签名 nonce | 自己的 SQLite/JSON（`$DSH_HOME/android-gateway/`） | DSH 无对应概念；需要事务与索引 |
| `conversationId ↔ sessionId`、`generationId ↔ turn`、幂等账本 | 自己的库 | 协议身份与 DSH 身份解耦 |
| SSE 事件 outbox（含 sequence/cursor/TTL） | 自己的库 | 协议要求账号级单调 sequence 与断线续传 |
| 待 claim 的设备请求队列 | 自己的库 | 协议 §8.3 状态机 |
| 插件配置 | `cordis.patch.yml` + `Config` | 用户可改、升级不丢（✅ `practices.md:22`） |

**不要**把协议状态写进 Session 日志：不能新增 `type`（reader 只接受带 `ignorable: true` 的未知事件，而 `Session.append()` **无法**设置该标记）——这是硬约束（✅源码 `dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:21`；`dsh-session/lib/types/types.d.ts:498-508`）。`appendPluginRecord` 只允许 `packages/experimental/` 下的包调用，本项目不能用（✅源码 `dsh-session/README.md:66-74`）。

### 8.6 初始化代码

```js
ctx.effect(() => {
  const profile = ctx.get('profileContext')
  const root = path.join(profile?.home ?? path.join(os.homedir(), '.dsh'), 'android-gateway')
  const state = openStateStore({ dir: root })   // 自己的 SQLite/JSON
  return async () => { await state.close() }
}, 'android-gateway: state store')
```

---

## 9. 模型与系统提示词

### 9.1 模型选择的三个层次（有坑）

| 层次 | API | 生效时机 | 依据 |
|---|---|---|---|
| 创建参数 | `agentOptions: { provider, model, reasoningEffort?, maxTokens? }` | **只对“第一次请求”有效**；之后用日志里的 `request/header` | ✅源码 `dsh-agent/lib/types/runtime-types.d.ts:313-319`（`agent/request` 注释：“agent options on the first request, the logged header afterwards”） |
| 会话内切换 | `installModelSelection(agentCtx, { current, assembled })` | 下一次进入 prompt assembly 的 step | ✅源码 `dsh-agent/lib/types/model-selection.d.ts:31-49` |
| 部署默认 | `ctx.agentDefaultModel.currentSelection()` / `saveSelection()` | 新 agent 缺省 | ✅源码 `dsh-agent-default-model/lib/types/index.d.ts:42-50` |

**重要推论**：对**已存在的会话**（resume/继续对话）来说，`resume({ agentOptions })` 并不能改变日志里已记录的模型路由；要改模型必须安装 selection（或监听 `agent/request` waterfall）。

零 harness import 的等效写法（本项目默认）：

```js
// 在 setup(agentCtx) 里安装；之后每个 step 的 agent/request 都会改写 provider/model
agentCtx.on('agent/request', async (_payload, next) => {
  const config = await next()
  return { ...config, provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
})
```

代价：不会自动写 `[model changed: ...]` 的 durable 通知（那是 `installModelSelection` 的附加行为）；需要的话自己 `agent.inject()` 一条说明。Web UI 正是这么做的（✅源码 `dsh-api-session-controller/lib/index.js:274-306,352-363`：`selectionFor` 里 `installModelSelection(agent.ctx, selection)`，`selection.current` 的 getter 在无 pending 时回退到 `session.requestHeader().config`，再回退到 `agentDefaultModel.currentSelection()`）。

因此本项目的模型策略建议：

```js
function resolveSelection(ctx, requested) {
  if (requested?.provider && requested.model) return requested
  const def = ctx.agentDefaultModel.currentSelection()
  const effort = requested?.reasoningEffort ?? def.reasoningEffort
  return {
    provider: requested?.provider ?? def.provider,
    model: requested?.model ?? def.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  }
}
```

**校验模型可用性**（App 的模型选择器需要）：

```js
const providers = ctx.llm.listProviders()                    // LlmProviderInfo[]（index.d.ts:281）
const models = await ctx.llm.listModels(provider)             // LlmModelInfo[]（:367）
await ctx.llm.resolveCallConfig({ provider, model })          // 校验 + 解析默认（:391）
```

（`resolveCallConfig` 会做 adapter 级校验；sdk-jsonrpc-server 在 `initialize` 里就是这样校验的，✅源码 `dsh-sdk-jsonrpc-server/lib/index.js:128-136`。）

### 9.2 绑定 preset（Web profile 必需）

```js
const presets = ctx.get('agentPresets')
if (presets !== undefined) {
  const resolved = await presets.resolve(presetId)           // 不传 = 当前默认
  await presets.mount(agentCtx, resolved.id)                 // 在 setup 里挂载
}
```

- `mount(ctx, id)` 必须传**未发布的 Agent 的 agentCtx**（✅源码 `dsh-agent-preset-registry/lib/types/index.d.ts:101-106`）。
- preset 的 `plugins` 列表决定这个 agent 有哪些工具/提示词/技能；Web profile 把工具都放在 preset 里（§0.3 坑 2）。
- 已有会话恢复时要用**它自己记录的 preset**（`session.header.agentPreset` 或 projection `agentPreset`），否则提示词/工具会与历史不一致（✅源码 `dsh-api-session-controller/lib/types/agent.d.ts:52-70` 的 resume 策略、`dsh-agent-preset-registry/README.md` 的 "Session logs retain the preset ID"）。

### 9.3 系统提示词

| 作用域 | API | 来源 |
|---|---|---|
| 全局（所有 agent） | `ctx.systemPrompt.section({ name, order, text })` | ✅源码 `dsh-system-prompt/lib/types/index.d.ts:250`，`PromptSection` 在 47-70 |
| 单个 agent | `setup(agentCtx) → agentCtx.systemPrompt.section(...)` | 同上（scoped 注册随 agent 销毁） |
| 每轮上下文 | `agent.inject(userMessage)`（durable user/message，进入下一个 step） | ✅源码 `dsh-agent/lib/types/runtime-types.d.ts:209` |

```js
export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'android-gateway',
    order: 900,
    text: 'You are serving a paired Android device. Prefer device capabilities over shell commands.',
  }))
}
```

注意：

- `section.name` 全局唯一，重复注册抛错（✅源码 index.d.ts:48-49 注释）。
- `complete: true` 表示“这是完整系统提示词”，同一时刻只能有一个生效，否则 assembly 失败（✅源码 63-69 行）。
- **不要**监听 `system-prompt/assemble` 去加工具或文本（✅源码 `practices.md:17`）。
- 每轮临时上下文用 `agent.inject()`，它会作为 `user/message` 落盘并进入后续请求（✅源码 `dsh-agent/README.md:47`）；不会唤醒空闲 agent，所以必须紧跟 `followup`/`steer`。

### 9.4 能不能“每轮临时 agent”？

可以，但要付代价。对比：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 长驻 agent（推荐） | 每个 conversation 一个 `AgentHandle`，持续 `followup` | 与 Web UI 同构；inbox/steer 可用；启动快 | 内存中保留 agent；需要自己做空闲回收 |
| B. 每轮创建/销毁 | 每轮 `ctx.agents.create()` → 跑完 `handle.dispose()` | 无需常驻；崩溃隔离好 | 每轮重建 preset/session 开销；`dispose()` 会 **remove session from store**（✅源码 `dsh-agent/README.md:40`）；下一轮必须 `resume`（需要 persistence），且 resume 可能与“已有 live agent”冲突 |
| C. 每轮 resume | `ctx.agents.resume({ resumeSessionId })` → 跑完 dispose | 不常驻；历史延续 | 每轮冷启动 IO；同一 id 不能同时 live（其他 owner 会拒：`session/agent-busy`，✅源码 `dsh-api-session-controller/lib/types/agent.d.ts:76-84`） |

**结论**：选 A。Gateway 的“一轮生成”只是同一 agent 的一次 `followup`，不是新 agent。只有在“一个会话可能被多个进程/设备并发驱动”时才需要 B/C，而这时正确做法是**用 writer lock + 409 拒绝并发**（DSH 的 resume 本身就有 writer-held 语义，✅源码 `dsh-api-session-controller/README.md:65`）。

---

## 10. 生命周期与清理

### 10.1 清理原语

| 原语 | 用法 | 来源 |
|---|---|---|
| `ctx.effect(fn, label?)` | `fn` 里注册、返回 disposer（可 async / generator）；卸载按逆序执行 | ✅源码 `cordis/lib/types/fiber.d.ts:148-159`；`Effect` 形状 43-49 |
| `ctx.on(event, listener)` | 返回同步 disposer | ✅源码 `cordis/lib/types/events.d.ts:88` |
| `ctx.inject([...], cb)` | 子 fiber；服务消失/卸载时自动清理块内注册 | ✅源码 `host-plugin.md:64` |
| `ctx.plugin(plugin, config?)` | 挂子插件，返回 fiber（可 `dispose()`） | ✅源码 `cordis/lib/types/registry.d.ts:198`；`dsh-api-session-controller` 用 `ctx.plugin(ArchivedSessionGate)`（README:75） |
| `AgentHandle.dispose()` | 停 loop、注销、移除 session、unwind scope | ✅源码 `dsh-agent/lib/types/index.d.ts:130-146` |
| `ctx.tools.register` 的返回值 | 注销工具 | ✅源码 `dsh-tools/lib/types/index.d.ts:637` |
| `webServer.register` 的返回值 | 注销路由 | ✅源码 `dsh-host-webserver/lib/types/index.d.ts:174` |
| `server.closeAllConnections()` | 强制关闭该 server 的全部连接（含 keep-alive 与 SSE 所在 socket） | Node 文档；本项目 §6.2 |

### 10.2 清理顺序（重要）

插件卸载时应当按以下顺序收敛（否则会“事件丢了”或“会话卡住”）：

1. **停止接收新请求**：HTTP server 不再 accept / 路由先返回 503；
2. **关闭 SSE**：给所有客户端发最后一个 `gateway.notice`（可选）→ `res.destroy()`；
3. **等待进行中的 turn 收敛或取消**：对每个自有 agent 调 `cancel({ kind: 'disposed' })`，再 `await agent.whenIdle()`（有超时上限）；
4. **flush 会话**：`await ctx.sessions.flush(agent.session)`（保证最后事件落盘）；
5. **dispose agent**：`await handle.dispose()`；
6. **注销订阅**：`ctx.on` 的 disposer（或交给 `ctx.effect` 自动做）；
7. **关闭私有存储**。

> 注意：如果插件由 **ctx 卸载**触发，步骤 3-5 也可以交给 `handle.dispose()`/fiber 自动完成；但“先 flush 再 dispose”的顺序在崩溃恢复上更稳（headless 的收尾就是先 `sessions.flush` 再读结果，✅源码 `dsh-headless/lib/index.js:356-358`）。

### 10.3 综合清理骨架

```js
export function apply(ctx, config) {
  const owned = new Set()          // AgentHandle
  const closers = []

  // HTTP + SSE
  const http = startHttpServer(ctx, config)
  closers.push(() => http.close())

  // 事件订阅
  closers.push(attachStreamBridge(ctx, http.publish))

  // 私有存储
  closers.push(() => stateStore.close())

  ctx.effect(() => () => {
    // 逆序清理；每步容错，不能让一个失败阻断其余
    return (async () => {
      for (const close of closers.reverse()) {
        try { await close() } catch (error) { ctx.logger.warn(error) }
      }
      for (const handle of owned) {
        try { handle.agent.cancel({ kind: 'disposed' }) } catch {}
        try { await withTimeout(handle.agent.whenIdle(), 10_000) } catch {}
        try { await ctx.sessions.flush(handle.agent.session) } catch {}
        try { await handle.dispose() } catch (error) { ctx.logger.warn(error) }
      }
      owned.clear()
    })()
  }, 'android-gateway: teardown')
}
```

### 10.4 定时器与心跳

- `setInterval(...).unref()`，避免拖住进程退出（`dsh-client-hmr` 的 watch 轮询就 `unref()`，✅源码 `dsh-client-hmr/lib/index.js:108-112`）。
- 心跳 timer 必须在 effect disposer 里 `clearInterval`。
- 不要用 `setTimeout` 做“等一轮结束”的主机制（`whenIdle` 更准确）；超时只做兜底。

### 10.5 卸载时的 agent 归属

`ctx.agents.create()` 的 owner 是**调用方 ctx**（本插件 fiber）。插件卸载 → 该 handle 的 agent 会被工厂 provider 停止并 drain（✅源码 `dsh-agent/lib/types/index.d.ts:130-141` 注释）。所以：

- 不需要自己保存每个 handle 的 dispose（但仍建议保存，便于按会话回收与顺序控制）；
- 若把 `create` 放在 `ctx.inject` 的子 fiber 里，清理会跟随子 fiber；
- **不要**在 `agent.ctx` 上注册资源却不保留 disposer：插件卸载不会自动清 `agent.ctx` 的注册（✅源码 `practices.md:8,19`）。

---

## 11. 结论清单：已验证 与 待验证

### 11.1 十个问题的答案索引

| # | 问题 | 章节 | 一句话结论 |
|---:|---|---|---|
| 1 | 宿主插件如何声明/加载 | §1 | `dsh.bundle.patch` + `cordis.patch.yml` + `apply(ctx, config)` + `inject` + schemastery `Config` |
| 2 | 如何拿 Agent/Session 服务、建会话跑一轮 | §2 | `ctx.agents.create({sessionId, meta.cwd, agentOptions, setup})` → `agent.followup()` → `whenIdle()` |
| 3 | 如何订阅流式事件、如何取消 | §3 | `session/event`（耐久）+ `agent/assistant-stream`（瞬时）+ `agent/status`；`agent.cancel({kind:'user'})` |
| 4 | 如何读历史并投影成消息 | §4 | `ctx.sessionQuery.readSession/readSurface` + 自己投影；活会话用 `deriveMessages()` |
| 5 | 如何注册工具、返回图片 | §5 | `ctx.tools.register(def)`（或 `defineTool`）；图片用 `attachments.saveImage` + `ImageBlock` |
| 6 | HTTP 服务怎么做 | §6 | `ctx.webServer.register`（仓库现状；SSE 支持、禁 wildcard、端口随 GUI）或自建 `node:http`（LAN 直连） |
| 7 | 附件存取 | §7 | `ctx.attachments.saveFileStream/saveImage` → `FileBlock/ImageBlock`；图片归一化、文件原样 |
| 8 | 私有数据放哪 | §8 | `ctx.profileContext.home` / `dshHomePath('android-gateway')`；协议状态自己存 SQLite/JSON |
| 9 | 模型与提示词 | §9 | 首次用 `agentOptions`，之后必须 `installModelSelection`；preset 用 `agentPresets.mount`；提示词 `systemPrompt.section` |
| 10 | 生命周期清理 | §10 | `ctx.effect` 统一收口；先停入口/关 SSE → cancel/flush → dispose agent → 注销订阅 |

### 11.2 已验证（源码/类型/本机环境）

| ID | 结论 | 证据 |
|---|---|---|
| V-01 | 插件导出 `apply` + `inject` + `Config`（或 default Service 类），Loader 用 `exports.default ?? exports` | `host-plugin.md:57-64`；`cordis-plugin-loader/lib/index.js:667-672` |
| V-02 | `Config` 通过 Standard Schema 校验；异步校验被拒绝 | `cordis/lib/index.js:956-962` |
| V-03 | bundle patch 的 `dsh.bundle.patch` 接受 string 或 string[] | `dsh-package-manifest/lib/types/types.d.ts:65-69` |
| V-04 | `AgentHandle` = `{ agent, dispose }`；`dispose` 移除 session | `dsh-agent/lib/types/index.d.ts:143-146`；README:40 |
| V-05 | `ctx.agents.create` 的 `meta.cwd` 必须是绝对路径 | `dsh-session/lib/types/index.d.ts:414` 注释 |
| V-06 | `Agent.cancel(cause, {keepInbox})` 默认清空排队 | `dsh-agent/lib/types/runtime-types.d.ts:157`；README:177 |
| V-07 | `agent/assistant-stream` 帧为 start/chunk/end，chunk 是 `StreamChunk` | `dsh-agent/lib/types/runtime-types.d.ts:107-137`；`dsh-llm/lib/types/types.d.ts:434-464` |
| V-08 | `session/event` 在提交后同步分发，回调异常被吞 | `dsh-session/lib/types/index.d.ts:51-61` |
| V-09 | `deriveMessages()` 返回模型可见消息、带缓存、深冻结 | `dsh-session/lib/types/index.d.ts:329-347` |
| V-10 | `eventAt/snapshotEvents/ownEvents` 已废弃 | `dsh-session/lib/types/index.d.ts:206-231` |
| V-11 | `ctx.sessionQuery.readSession` 返回整份日志，无分页 | `dsh-session-query/lib/types/index.d.ts:69-74`；types.d.ts:36-43 |
| V-12 | `ctx.sessionQuery.readSurface` 返回当前 surface 事件 | 同上 :127；types.d.ts:25-34 |
| V-13 | `ToolDefinition` 必填 `output.{schema,render}`，`execute` 只返回 canonical JSON | `dsh-tools/lib/types/index.d.ts:106-128` |
| V-14 | `register` 返回 disposer；作用域注册 shadow 全局 | 同上 :631-637 |
| V-15 | 工具图片结果 = `ImageBlock{ attachment: ImageAttachmentRef }` | `dsh-llm/lib/types/types.d.ts:61-71`；`dsh-tool-fs/lib/index.js:966-974` |
| V-16 | 文件块不下发字节，只给模型路径提示 | `dsh-attachment/README.md:40,105`；`dsh-llm/lib/types/types.d.ts:72-83` |
| V-17 | `saveFileStream` 接受 `AsyncIterable<Uint8Array>` + `signal` | `dsh-attachment/lib/types/types.d.ts:56-63` |
| V-18 | 图片默认上限：20 MiB / 20 张 / 200 MiB / 64MP / 8192px / 归一化 2048² | `dsh-attachment-local/README.md:38-49` |
| V-19 | 附件永不自动删除；图片会归一化（GIF 只留首帧） | 同上 :119,135,137 |
| V-20 | `webServer` handler 拿原始 `IncomingMessage`/`ServerResponse`，可保持长连接（SSE） | `dsh-host-webserver/lib/types/index.d.ts:34-40`；`lib/index.js:380-391` |
| V-21 | webserver **拒绝** wildcard 绑定 | `dsh-host-webserver/README.md:39`；`lib/types/index.d.ts:60-69` |
| V-22 | 同一 realm 内重复 `provide` 同名服务抛错（只能一个 webServer） | `cordis/lib/types/reflect.d.ts:35-44` |
| V-23 | `ctx.effect` 接受 async disposer，卸载 await | `cordis/lib/types/fiber.d.ts:43-49,148-159` |
| V-24 | `resolveDshHome` 优先级：显式 > `$DSH_HOME` > `~/.dsh` | `dsh-home-paths/README.md:25-40` |
| V-25 | profile 目录 = `$DSH_HOME/profiles/<name>`；home patch 在 `$DSH_HOME/cordis.patch.yml` | `dsh-app-boot/lib/index.js:507,546`；`dsh/lib/profile-boot-*.js:115-117` |
| V-26 | `ctx.profileContext` 提供 `{name, dir, patchPath, installAnchor, cwd, home}` | `dsh-app-boot/lib/types/profile-context.d.ts:10-31` |
| V-27 | Web profile 把工具行 disabled，工具由 preset 提供 | `dsh-web-app/cordis.patch.yml:460-520` |
| V-28 | `agentOptions` 只对首个请求有效，之后用日志 header | `dsh-agent/lib/types/runtime-types.d.ts:313-319` |
| V-29 | `installModelSelection` 让后续 step 使用新选择，并写 durable 通知 | `dsh-agent/lib/types/model-selection.d.ts:31-49` |
| V-30 | `agentPresets.mount(agentCtx, id)` 必须在 `setup` 中对未发布 agent 调用 | `dsh-agent-preset-registry/lib/types/index.d.ts:101-106` |
| V-31 | `systemPrompt.section` 全局唯一 name；`complete` 只能一个 | `dsh-system-prompt/lib/types/index.d.ts:47-70,250` |
| V-32 | 不能新增 Session 事件类型（`append()` 无法设置 `ignorable`） | `practices.md:21`；`dsh-session/lib/types/types.d.ts:498-508` |
| V-33 | 本机存在 0.1.0-rc.7 与 0.2.1-rc.2 两套 DSH；profile 软链指旧版 | 环境实测（`readlink`/`version`/`createRequire`） |
| V-34 | 运行中的 GUI = `0.2.1-rc.2-r1` 的 `dsh web --port 43535` | 环境实测（`ps`） |
| V-35 | `whenIdle()` 只表示静止，不标识某条消息完成 | `dsh-agent/lib/types/runtime-types.d.ts:164` 注释 |
| V-36 | 从本仓库路径 `import '@deepseek-ai/*'` 会 `MODULE_NOT_FOUND`；复制进 profile 则解析到旧版 `0.1.0-rc.7` | 环境实测（`createRequire(...).resolve()` + `readlink`，见 §0.3 坑 1） |
| V-37 | `Config` 只需实现 Standard Schema 的 `~standard.validate`；Cordis 不要求 schemastery 实例 | `cordis/lib/types/registry.d.ts:83-92`；`cordis/lib/index.js:956-962` |

### 11.3 推测 / 待验证（编码前必须写最小 demo）

| ID | 待验证结论 | 风险 | 验证方法（10 分钟内） |
|---|---|---|---|
| U-01 | host 全局 `ctx.tools.register` 的工具对 **preset 组合的 agent** 可见 | 若不可见，设备工具要改成 per-agent 注册 | 写一个 `echo` 工具 + 在 `setup` 里 `mount('standard')`，让 model 调它 |
| U-02 | 手写 `parameters` JSON Schema（不经 `defineTool`）能被 loop 正确接受并投影给 provider | 若 loop 依赖 `defineTool` 的编译产物，schema 会缺字段 | 用同一 demo 调一次，检查 `request/header.header.tools[].parameters` |
| U-03 | `ctx.sessionController.*`（create/prompt/cancel/readSurface 等）可从插件直接调用，且以 owner 身份执行 | 若被 `invocation`/`remoteAccess` 拦截，只能走 `ctx.sessionQuery` + 自己驱动 agent | 仓库 `src/dsh/bridge.ts` 已采用该路径；需 e2e 覆盖冷会话创建、并发取消、附件 receipt（`principalOf(undefined) → undefined` 已从源码确认，✅ `dsh-typert-protocol/lib/index.js:294-297`） |
| U-04 | `sessionQuery.readSession` 对“正在被 agent 写入”的活会话返回一致快照 | 若读到半截，需要改用 `observeSession`/增量 | 流式生成中反复读，检查 seq 单调与末条完整 |
| U-05 | `createUserMessage` 的品牌/冻结不是必须——手写 `{id, role, content, source}` 可被 `followup` 接受 | 若 loop 校验 message 形态会抛错 | 直接 `followup` 手写消息，跑通一轮 |
| U-06 | `agent.cancel({kind:'user'})` 后 `whenIdle()` 一定会 resolve | 若卡住，SSE 的取消终态无法发 | 起一轮长生成 → cancel → `Promise.race(whenIdle, 5s)` |
| U-07 | 在同一插件里再起一个 `dsh-host-webserver`（新 realm/isolate）可行 | 若不可行，方案 A 只能复用 GUI 端口 | 用 `isolate` 起 second webserver，`curl` 两个端口 |
| U-08 | `session/event` 对“其他 owner 创建的 session”也可被 host 监听器收到 | 若被 scope 过滤，SSE 需要 per-agent 订阅 | 用 Web UI 起一个会话，插件里打印收到的 session.id |
| U-09 | `setup` 中 `await` 的耗时操作不会阻塞 agent 发布太久（有超时/取消） | 若阻塞，创建设置超时 | 在 setup 里 sleep 2s，测 create 的耗时与取消 |
| U-10 | `attachments.saveFileStream` 直接吃 `IncomingMessage` 可行（背压/中断） | 若 Node 流类型不匹配，需要 `Readable.toWeb`/手动迭代 | 上传 50MB 文件，检查内存与中断 |
| U-11 | 0.2.1 与 0.1.0 两套包之间的 brand/类实例可混用 | 若不可混用，import 版本必须严格对齐 | 在插件里 import 并比对 `package.json` version |
| U-12 | `ctx.agents.resume()` 在 web profile（已有 preset 记录）下能正确恢复工具/提示词 | 若 preset 解析失败，恢复会话会缺工具 | 建会话 → 重启 → resume → 看 `agent.ctx.tools.schemas()` |
| U-13 | `sessionController.follow` 的 `assistantStream` 帧足以支持重连后逐字恢复 | 若 baseline 不完整，重连只能从 completed 开始 | 流式中断开 SSE → 带 cursor 重连 → 对比文本 |
| U-14 | `ctx.webServer.register` 的 prefix 路由与 GUI 的 `/api` 不冲突（自定前缀） | 若冲突会 404 | `curl /gateway/health` 与 `/api/...` 并存 |
| U-15 | 手写 Standard Schema（无 `listConfigs`）能正常激活，只是配置 UI 可能不显示字段 | 若安装/启用被阻断，需要补 schemastery 或自定义 UI | 装插件、改 `cordis.patch.yml` 的 config、看是否按默认值激活 |

> 建议把这些验证做成仓库里的 `test/spikes/*.md` + 可执行脚本（一次性，跑完记录结论），再进入正式实现。

---

## 12. 对本项目的架构建议

### 12.1 分层：三层 + 两个存储域

```text
┌───────────────────────────────────────────────────────────────┐
│ L1 Gateway 传输层（自己实现，node:http / node:https）          │
│   · 路由表（exact/prefix）· 信封 · 错误码 → HTTP 状态           │
│   · 九 header 验签 · 幂等账本 · SSE（含 cursor/heartbeat）      │
│   · 附件三步上传（流式落盘）                                    │
├───────────────────────────────────────────────────────────────┤
│ L2 DSH 适配层（用 ctx 服务）                                    │
│   · 会话生命周期：agents.create/resume/get + handle.dispose     │
│   · 一轮生成：followup/steer/cancel/whenIdle                    │
│   · 事件：session/event · agent/assistant-stream · agent/status │
│   · 历史：sessionQuery / session.deriveMessages                 │
│   · 附件：attachments.saveImage/saveFile(Stream)/read*          │
│   · 工具：ctx.tools.register（设备能力）                         │
│   · 模型/preset：agentDefaultModel / llm / agentPresets          │
│   · 配置/路径：Config / profileContext                           │
├───────────────────────────────────────────────────────────────┤
│ L3 协议映射层（自己实现，纯函数 + 状态机）                       │
│   · conversationId ↔ sessionId · generationId ↔ turn            │
│   · message.delta（累积文本）· completed · status 状态机         │
│   · 历史分页 cursor / snapshotRevision · 附件 id 映射            │
│   · 设备请求队列（claim/result/expire）                          │
└───────────────────────────────────────────────────────────────┘
          │ 持久化                          │ 二进制
          ▼                                 ▼
  私有 SQLite/JSON                     ctx.attachments
  ($DSH_HOME/android-gateway/)         ($DSH_HOME/attachments)
```

**核心原则**：DSH session log 是“模型可见事实”的唯一真源；协议层是**投影 + 索引 + outbox**，不能反向污染日志。

### 12.2 哪些用 DSH 服务 API，哪些必须自己实现

**直接用（不要重造）**：

| 能力 | 用哪个 API | 理由 |
|---|---|---|
| Agent 生命周期 | `ctx.agents.create/resume/get` + `AgentHandle.dispose` | 含 preset/session 事务、写入锁、崩溃修复 |
| 一轮驱动 | `agent.followup/steer/cancel/whenIdle` | inbox、turn/step 状态机、取消语义都在 loop 里 |
| 流式 | `agent/assistant-stream` | 唯一 token 级来源 |
| 耐久事件 | `session/event` | 提交后事件、持久化保证 |
| 历史 | `ctx.sessionQuery`（冷）/ `deriveMessages`（热） | 已实现 surface 投影、fork/filter/trace |
| 附件 | `ctx.attachments` | 内容寻址、校验、归一化、去重、provider 请求版本 |
| 工具 | `ctx.tools.register`（手写定义；`defineTool` 仅在可解析时） | 权限管线、并发调度、结果持久化、UI 呈现；参数/输出契约自己实现（注册表不校验） |
| 模型目录/校验 | `ctx.llm.listProviders/listModels/resolveCallConfig`，`ctx.agentDefaultModel` | adapter 能力与默认值 |
| preset | `ctx.agentPresets.mount/resolve` | Web profile 的工具都在 preset 里 |
| 路径 | `ctx.profileContext` / `dshHomePath` | 与部署一致，不硬编码 |
| 提示词 | `ctx.systemPrompt.section` / `agentCtx.systemPrompt.section` / `agent.inject` | 走 durable 通道，可 replay |

**必须自己实现（DSH 没有）**：

| 能力 | 说明 |
|---|---|
| Gateway HTTP 路由 + 信封 + 错误映射 | 协议 §1/§9 |
| 认证/配对/九 header 验签/幂等账本 | 协议 §2/§6；DSH 只有 GUI 的 cookie 鉴权，不适用 App |
| SSE outbox（账号级 sequence、cursor、TTL、`CURSOR_EXPIRED`） | 协议 §4.2；DSH 没有账号级事件总线 |
| `conversationId ↔ sessionId`、`generationId ↔ turn`、`messageId ↔ MessageId` 映射 | 协议 ID 是 wire ID，DSH 的 `SessionId`/`MessageId` 不能直接暴露（也不该暴露） |
| `message.status` 状态机（queued/delivered/completed/failed + revision） | 协议 §4.4；DSH 只有 inbox 与 turn 状态 |
| 历史分页 cursor + `snapshotRevision` | 协议 §5.5；DSH 只有日志 |
| 消息批次（`message-batches`，聚合/回切） | 协议 §5.6；纯 Gateway 层逻辑 |
| 附件协议生命周期（created/uploaded/committed/verified/expired） | 协议 §7；DSH 附件是“写入即持久”，没有协议状态机 |
| 命令目录 / 组织 / 快照 / 审批卡片等 | 协议 §5.9-§5.13、§6 |
| 设备能力发现/请求队列/claim/result | 协议 §8；对应 DSH 工具实现里的“等设备结果”循环 |
| 多设备/多账号隔离与审计 | DSH 是单机单用户模型，账号域必须自建 |

### 12.3 与 `gateway-protocol.md` 的概念映射

| 协议概念 | DSH 承载 | 注意 |
|---|---|---|
| `conversation` | `Session`（+ 自己的元数据表） | 一个会话 = 一个 DSH session；cwd/preset 存 header |
| 用户消息 | `user/message`（`followup`/`steer` 产生） | 不要自己 append；revision/状态自己维护 |
| 助手消息 | `assistant/message` | `data.message.content` 是块数组；`usage` 在 `data.usage` |
| `message.delta` | `agent/assistant-stream` | 协议要**累积全文**，自己累加 |
| `message.completed` | `assistant/message` 提交 | 一条 completed 只结束该消息（协议 §4.4） |
| `message.status` | `agent/inbox/claimed`（delivered）+ `turn/end`（completed/failed） | revision 自增自己维护 |
| `generation` | 一轮 turn（`turn/start`…`turn/end`） | `generationId` 自己生成并绑定 |
| `generations/current` | `agent.status` + 自己的 generation 表 | 空闲/运行以 `agent/status` 为准 |
| 取消 | `agent.cancel({kind:'user'})` | 注意默认清空 inbox；终止态看 `turn/end.reason` |
| 历史分页 | `sessionQuery.readSession/readSurface` 或 `sessionController.page` | 协议 cursor 不要暴露 DSH seq |
| 附件 | `ctx.attachments` | 归一化后 sha256 会变；授权要按会话日志 |
| 设备能力工具 | `ctx.tools.register` + 设备请求队列 | 工具只接受 capabilityId/version/params |
| 审批卡片 | `ctx.tools` 的 `ask` 决策 + `dsh-user-approval` | 协议 §5.9 的事件由自己发 |
| 会话标题 | `session/title` 事件 或自己的表 | `dsh-session-title*` 已挂载（base） |
| 归档/删除 | 自己的表 + `agent` 未运行；DSH 无归档概念 | 删除会话要先 cancel + dispose |

### 12.4 风险清单与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **`@deepseek-ai/*` 不可解析**（外部 checkout）或解析到旧版（复制进 profile） | 插件加载直接失败，或类实例/brand 不兼容 | **零 harness import**：只依赖 `node:` + 仓库自有依赖 + `ctx` 服务；`Config` 手写 Standard Schema；消息/工具用普通对象。若确需依赖，必须把插件放进 `$DSH_HOME/profiles/*` 并锁定与运行时一致的版本（目前不可行） |
| R2 | **Web profile 工具在 preset 里** | 不挂 preset 的 agent 没工具，模型只会聊天 | `setup` 里 `mount(preset)`；用 `ctx.tools.schemas(agent)` 自检 |
| R3 | `ctx.webServer` 不能绑 wildcard、端口不可选、单实例 | 真机连不上 | 自建 node:http，绑可配置地址；`adb reverse` 作为默认安全路径 |
| R4 | **网关暴露 LAN 后无鉴权** = 任意人可驱动 Agent | 严重安全事故 | 强制协议 §2 认证 + 九 header 签名；无 auth 配置时拒绝非回环绑定 |
| R5 | 瞬时流不可重放 | 断线重连看到“跳字”或空白 | 自建 per-session ring buffer（对齐 `attemptId/revision/nextIndex`），或重连只补 `completed` |
| R6 | `session/event` 回调里做 IO 拖慢 append | 所有会话变慢 | 回调只入队；异步 worker 消费 |
| R7 | 底层 `agent.cancel` 默认清空队列 | App 里排队的消息凭空消失 | 用 `{keepInbox:true}`；若走 `sessionController.cancel`，它已经是 `keepInbox:true`（✅源码 `lib/index.js:1065`） |
| R8 | resume 与 live agent 冲突（writer-held/agent-busy） | 多设备并发 409 | 单写者锁 + 协议错误映射；多设备只读镜像 |
| R9 | 附件归一化改变字节 | App 的 sha256/大小校验失败 | 协议层对“归一化后字节”计算 sha256；或文件类走 `saveFile`（原样） |
| R10 | 附件永不 GC | 磁盘涨满 | 自己按会话/时间清理 DSH 附件目录需谨慎（DSH 不做引用计数）→ 至少做配额告警；协议层附件 TTL 与 DSH 存储解耦 |
| R11 | Session 日志无限增长 | 内存/磁盘、历史变慢 | 启用 compaction（base 已挂 `compaction-basic`），历史展示走 append-origin 投影 |
| R12 | 协议要求“提交后立即投递” | SSE 丢事件 | 自己的 outbox 用同事务写库 + 投递；失败重试不从日志“猜” |
| R13 | 设备工具阻塞 turn | turn 卡住、App 转圈 | 工具内 `Promise.race([device, timeout, signal])`，超时返回 `outcome_unknown` |
| R14 | 插件升级/替换必须重启 | 线上断连 | 维护窗口；SSE 客户端按 cursor 重连；`CURSOR_EXPIRED` 时走快照重建 |
| R15 | `sessionController` 是 Remote 服务 | 直接调用可能受鉴权影响 | 先用 U-03 验证；不行就用 `sessionQuery` + 自己投影 |
| R16 | 会话 id 复用/清理 | 删除后重建同名会话读到旧历史 | 自己的 conversation 表生成新 sessionId；删除时确保 DSH 侧无 live agent |

### 12.5 建议的模块拆分

```text
src/
  index.js                 # 插件入口：Config、apply、effect 编排
  config.js                # schemastery Config
  http/
    server.js              # node:http 生命周期、路由匹配、body 读取
    envelope.js            # 成功/失败信封、错误码 → 状态
    auth/                  # 密码/邀请/设备密钥、九 header 验签、nonce
    sse.js                 # SSE 连接管理、心跳、cursor
  adapter/
    sessions.js            # conversation ↔ DSH session；create/resume/dispose
    turns.js               # followup/cancel/whenIdle；generation 表
    stream.js              # agent/assistant-stream → 累积文本 → delta
    history.js             # sessionQuery/deriveMessages → 协议时间线
    attachments.js         # 上传 → ctx.attachments；下载路由
    tools/                 # 设备能力工具注册
    model.js               # 模型选择/目录
  store/                   # 私有 SQLite：账号、设备、会话、generation、outbox、幂等
  protocol/                # 协议 schema 校验、ID、JCS、签名预像
test/
  spikes/                  # §11.3 的一次性验证脚本 + 结论
  unit/                    # 纯函数（信封、状态机、投影）
  e2e/                     # 用真实 DSH + 假 App 跑一轮
```

### 12.6 落地顺序（建议）

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0（1-2 天） | 跑完 §11.3 的 U-01/U-02/U-05/U-06/U-08 | 每个 spike 有结论记录，决定关键路径 |
| M1 | 插件骨架 + Config + 自建 HTTP + `/healthz` + 生命周期 | 插件可装/可禁；端口随启停开关 |
| M2 | `conversation` 创建 + 发消息 + `whenIdle` + `assistant/message` → `completed`（非流式闭环） | App 能发一条消息并看到完整回复 |
| M3 | SSE + `assistant-stream` → `delta` + `status` 状态机 + `cancel` | 流式可见、能停止 |
| M4 | 历史分页 + 附件上传/下载 | App 能翻历史、发图 |
| M5 | 模型选择 + preset + 设备工具（claim/result） | 模型可切、设备能力可调 |
| M6 | 协议一致性（九 header、幂等、cursor、快照重建）+ 压测 | 向量/契约测试通过 |

### 12.7 可借鉴的现成实现：`dsh-sdk-jsonrpc-server`

它是最接近本项目的“服务端插件”范例（stdio JSON-RPC，不是 HTTP）：

- 一个 `HarnessSdkJsonRpcServer` 类持有 `sessions: Map<sessionId, { handle, failure }>`；
- 构造时订阅 `session/event` / `agent/status` / `agent/error` / `session/created`，把事件 `notify` 给 transport；
- `prompt()` 做“图片 → 附件 ref → `createUserMessage` → `followup`”；
- `createSession()` 做 `ctx.agents.create/resume({sessionId, meta:{cwd}, agentOptions})`；
- `shutdown()` 先解订阅、再 `dispose()` 所有 handle；
- 插件入口是 `export const name/inject/Config` + `export function apply` + `ctx.effect`。

（✅源码 `dsh-sdk-jsonrpc-server/lib/index.js:62-120,156-166,318-341,360-420`。）

**可以直接抄的结构**：会话表 + 事件转发 + 优雅关闭。
**不能直接抄的**：wire 协议（JSON-RPC over stdio ≠ Gateway Protocol v2.1），以及它对“一个 prompt 不保证一轮结果”的取舍（`README.md:52-54`）——协议要求每轮有终态。

### 12.8 不要做的事

- ❌ 不要 `import '@deepseek-ai/dsh-agent-loop'` 去自己 new agent（会绕开 registry/ownership，且跨版本脆弱）。
- ❌ 不要自己 append `user/message` / `assistant/message`（会与 loop 的 admission/header 机制打架）。
- ❌ 不要新增 Session 事件类型（`ignorable` 限制，见 V-32）。
- ❌ 不要用 `eventAt/snapshotEvents`（已废弃）。
- ❌ 不要把 DSH 的 `SessionId`/`MessageId` 直接暴露给 App（协议要求 wire ID 不透明且可重建）。
- ❌ 不要在 `session/event` 回调里直接写 SSE（慢消费者会拖住所有 append）。
- ❌ 不要把插件私有数据写进 profile 的 `cordis.yml`（那是 launcher 生成的空根；用户配置进 `cordis.patch.yml`）。

---

## 附录 A：引用文件索引

按包列出本报告引用到的文件（均相对 `$RT`）：

| 包 | 文件 | 用到的行/内容 |
|---|---|---|
| `dsh-agent` | `lib/types/runtime-types.d.ts` | AgentOptions 21-30；CancelOptions 32-39；AssistantStreamFrame 107-137；Agent 141-211；事件 227-407 |
| `dsh-agent` | `lib/types/index.d.ts` | CreateAgentOptions 48-104；ResumeAgentOptions 109-128；AgentHandle 143-146；AgentFactory 153-185；AgentRegistry 198-379 |
| `dsh-agent` | `lib/types/types.d.ts` | Agent 11-14；InboxTarget 31；`agent/inbox/spliced` 86-93 |
| `dsh-agent` | `lib/types/model-selection.d.ts` | ModelSelection 16-23；installModelSelection 31-49 |
| `dsh-agent` | `README.md` | 创建/驱动 30-67；限制 174-178 |
| `dsh-session` | `lib/types/index.d.ts` | Session 135-355；SessionStore 378-516；事件声明 26-76 |
| `dsh-session` | `lib/types/types.d.ts` | SessionId/Seq 5-32；SessionHeader 59-96；CreateSessionOptions 102-124；取消/结束原因 149-211；EpochHeader 218-229；SessionEventMap 256-434；SurfaceOp 459-463；SessionEvent 490-513 |
| `dsh-session` | `lib/types/surface.d.ts` | 投影函数 52-141；SessionSurface 118 |
| `dsh-session` | `README.md` | 读取/派生 40-62；限制 202-206 |
| `dsh-agent-loop` | `lib/types/index.d.ts` | Config 80-97；AgentLoop 99-177 |
| `dsh-agent-loop` | `README.md` | 创建/驱动 59-75；请求头 93；创建事务 110-116；turn 流程 118-122 |
| `dsh-tools` | `lib/types/index.d.ts` | ToolOutputDefinition 106-113；ToolDefinition 114-191；ToolExecutionInput 216-242；ToolRunContext 305-322；ToolRuntime 527-852；PreToolDecision 445+ |
| `dsh-tools` | `lib/types/schema.d.ts` | 参数 DSL 40-110；DefineToolOptions 178-240；defineTool 248 |
| `dsh-tools` | `README.md` | 注册示例 38-62；管线 109/141；限制 225-240 |
| `dsh-llm` | `lib/types/types.d.ts` | ContentBlock 46-126；StreamChunk 434-464；ToolSchema 472-483 |
| `dsh-llm` | `lib/types/message.d.ts` | UserMessage 144-146；AssistantMessage 148-151；ToolResultMessage 153-160；createUserMessage 213-216 |
| `dsh-llm` | `lib/types/index.d.ts` | listProviders 281；listModels 367；resolveCallConfig 391；prepareCall 407 |
| `dsh-host-webserver` | `lib/types/index.d.ts` | WebRoute 34-40；Config 60-88；WebServer 129-224 |
| `dsh-host-webserver` | `lib/index.js` | 请求分发 380-410；close/upgrade 逻辑 412-470 |
| `dsh-host-webserver` | `README.md` | 绑定规则 39；路由 61；压缩 41；限制 129-131 |
| `dsh-attachment` | `lib/types/index.d.ts` | AttachmentStore 18-130 |
| `dsh-attachment` | `lib/types/types.d.ts` | refs 7-41；limits 65-73；stream 56-63 |
| `dsh-attachment` | `lib/types/admission.d.ts` | admitEncodedImages 14；admitEncodedFile 25 |
| `dsh-attachment` | `lib/types/error.d.ts` | 错误码 4-40 |
| `dsh-attachment-local` | `README.md` | 配置 38-49；路径 55,84-90；限制 119,135-137 |
| `dsh-attachment` | `README.md` | 语义 28-52；文件 71-75；限制 116-120 |
| `dsh-session-query` | `lib/types/index.d.ts` | 服务 35-153 |
| `dsh-session-query` | `lib/types/types.d.ts` | 记录 14-120 |
| `dsh-session-query` | `README.md` | 能力表 30-46；失败码 60-64 |
| `dsh-session-persistence-jsonl` | `README.md` | 配置 38-52；磁盘布局 54-70 |
| `dsh-home-paths` | `README.md` | 解析 25-40 |
| `dsh-app-boot` | `lib/index.js` | PROFILES_DIR 507；resolveProfileDir 546；version 271-275 |
| `dsh-app-boot` | `lib/types/profile-context.d.ts` | ProfileContext 10-31 |
| `dsh/lib/profile-boot-*.js` | 任意 hash 文件 | home patch 115-117；层叠说明 76-80 |
| `dsh-api-session-controller` | `lib/types/index.d.ts` | 服务 16-215 |
| `dsh-api-session-controller` | `lib/types/types.d.ts` | prompt/page/follow/cancel 332-550；`model/selection` 36 |
| `dsh-api-session-controller` | `lib/index.js` | 订阅 1453/1546；composeAgent 352-363；selectionFor 274-306；inject 2917-2928 |
| `dsh-api-session-controller` | `README.md` | create/resume 策略 44；分页 67-69；限制 116-127 |
| `dsh-agent-preset-registry` | `lib/types/index.d.ts` | 服务 17-160 |
| `dsh-agent-preset-registry` | `lib/index.js` | register/activate 470-520；agentPreset projection 42-54 |
| `dsh-agent-preset-registry` | `README.md` | preset 语义 30-60 |
| `dsh-agent-default-model` | `lib/types/index.d.ts` | currentSelection/saveSelection 42-50 |
| `dsh-system-prompt` | `lib/types/index.d.ts` | PromptSection 47-70；section 250 |
| `dsh-working-directory` | `lib/types/index.d.ts` | get/ensure/set 64-83 |
| `dsh-headless` | `lib/index.js` | summarize 112-133；运行流程 300-360；assistant-stream 153-180 |
| `dsh-sdk-jsonrpc-server` | `lib/index.js` | 订阅 68-100；prompt 156-166；createSession 318-341；插件导出 369-380；apply 381-420 |
| `dsh-sdk-jsonrpc-server` | `README.md` | 能力 28-58；限制 129-133 |
| `dsh-client-hmr` | `lib/index.js` | SSE 114-160；Config/inject 25-26 |
| `dsh-tool-fs` | `lib/index.js` | read_image 966-1070（图片工具范例） |
| `dsh-client-connection` | `lib/types/rpc-host.d.ts` | requestRejection/admit 37-46 |
| `dsh-scope` | `README.md` | scope 语义 30-44 |
| `cordis` | `lib/types/fiber.d.ts` | Effect 43-49；effect 148-159 |
| `cordis` | `lib/types/events.d.ts` | on 88 |
| `cordis` | `lib/types/reflect.d.ts` | get/provide 6-44 |
| `cordis` | `lib/index.js` | resolveConfig 956-962 |
| `cordis-plugin-loader` | `lib/index.js` | unwrapExports 667-672 |
| `dsh-package-manifest` | `lib/types/types.d.ts` | bundle/profile manifest 33-74 |
| 技能文档 | `dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md` | 1-70 |
| 技能文档 | `.../references/practices.md` | 1-38 |
| 技能文档 | `dsh-agent-preset/skills/cordis-composition-reference/SKILL.md` | 10-29 |
| 本仓库 | `docs/research/gateway-protocol.md` | 传输/SSE/生成/附件/设备章节 |

## 附录 B：术语对照

| 术语 | 含义 |
|---|---|
| Agent / `AgentHandle` | 一个可驱动的会话执行体；handle 是“可销毁凭证” |
| Session | append-only 事件日志 + 派生消息；模型可见事实的唯一真源 |
| turn / step | turn = 一次用户输入引发的完整回合；step = 一次模型请求 + 其工具执行 |
| surface | 日志中“产生消息”的有序视图（可被 replace 压缩） |
| preset | 一组插件行，决定一个 agent 的工具/提示词/技能 |
| projection | 从日志增量折叠出的派生状态（如 inbox、turn boundary、model selection） |
| lease / scope | Cordis 的作用域与注册生命周期 |
| durable / transient | 是否落盘进 session 日志；transient 事件重连不可重放 |

---

> 报告版本：2026-10-20，对应 DSH `0.2.1-rc.2`。
> 建议维护方式：每验证一个 §11.3 的 U 项，就把结论并入 §11.2，并在 `test/spikes/` 留下可执行证据。

