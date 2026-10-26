# DSH 原生会话适配器 (OAI Core 0.2 Native Session Adapter)

本仓库提供适配 **Open Android Intelligence (OAI) Core 0.2** 的 **DeepSeek Harness (DSH)** 原生会话适配器插件。

在 OAI Core 0.2 统一架构中，Android 设备连接、账号认证、设备能力、请求调度和多 Agent 会话路由全部由 OAI Core 统一纳管。DSH 插件**不再提供独立 Android Gateway 服务**，只作为轻量 Cordis 插件提供 DSH 原生会话接口桥接。

## 架构演进

### 最终架构
```text
Android App ↔ OAI Core ↔ DSH Native Session Adapter ↔ DSH
```

手机通过 OAI Core 的统一服务端口查看服务端已配置的 DSH 实例及其真实原生会话。

### 职责边界
1. **DSH 插件**：
   - 使用 DSH 原生插件机制（Cordis bundle）安装和加载。
   - 只提供原生 Session API 与宿主事件桥接。
   - 不再启动独立 Android Gateway 端口或 WebSocket。
   - 不创建 Gateway 账号库或设备请求状态机。
   - 不再复制 Gateway Protocol v2 的设备认证和权限实现。
   - 不维护第二套会话历史或会话镜像。
   - 与 OAI Core 的通用 Remote Session Adapter 契约保持一致。
2. **OAI Core**：
   - 统一管理所有 Android 客户端连接、配对认证与设备凭据。
   - 统一提供 MCP/CLI/REST 设备操作面。
   - 负责 Agent 路由与会话请求转发。

## DSH 会话规则（部署级共享模式）

本插件采用部署级共享模式（`sessionScope: "deployment"`）：

- 所有登录 OAI Core 的有效账号，均可读取当前已明确接入的 DSH 实例所包含的真实原生会话。
- 通过宿主真实 `sessionQuery.listSessions()` 读取原生会话列表。
- 自动包含电脑终端创建的已有会话、后续在终端创建的新会话，以及从 OAI App 创建的新会话。
- 会话历史来自宿主真实 `sessionQuery.readSurface()`。
- 不按 OAI 账号过滤 DSH 共享会话，不扫描未配置的其他用户目录、DSH Profile 或其他服务实例。
- 严禁将 DSH 共享会话误判为独立 OAI 账号会话。

## 原生能力支持与协商

插件动态探测宿主服务能力：

- `sessionQuery.listSessions` -> `list`
- `sessionQuery.readSurface` -> `history`
- `sessionController.create` -> `create`
- `sessionController.prompt` + `session/event` -> `send` / `stream`
- `sessionController.rename` -> `rename`
- `sessionController.cancel` -> `cancel`

> **注意**：当前未验证可靠的原生删除与归档能力，因此默认不声明 `delete` 和 `archive`（置为 `false`）。严禁用本地隐藏或墓碑伪装原生删除。

## 内部接口规范

遵守 OAI Core 会话桥规范：
- 默认监听：`127.0.0.1:8791`
- 路径前缀：`/oai/session-adapter/v1`
- 内部鉴权：通过环境变量（默认 `OAI_DSH_ADAPTER_TOKEN`）配置共享 Token（长度至少 32 字符），请求头 `Authorization: Bearer <TOKEN>`
- 请求预算：请求体严格限制小于 1 MiB（1048576 字节），超限返回 413 `PAYLOAD_TOO_LARGE`
- 响应格式：使用 NDJSON (`application/x-ndjson`) 转发宿主消息流增量及终态事件

## 安装与部署

### 1. 配置环境变量

在 Core 与目标 DSH 宿主进程环境中配置同一个至少 32 字符的随机 Token：
```bash
export OAI_DSH_ADAPTER_TOKEN="your-secure-loopback-token-at-least-32-chars-long"
```

### 2. 在 DSH 中安装插件

通过 DSH `plugin_manager` 安装本 Bundle：
```text
plugin_manager action=install_bundle target=/absolute/path/to/dsh-android-gateway
```
安装后重启目标 DSH profile 使配置生效。

### 3. 在 OAI Core 中配置 Agent

在 OAI Core 的配置文件（`config.json` 或环境变量）中的 `agents` 数组添加：
```json
{
  "id": "dsh",
  "name": "DSH",
  "type": "dsh",
  "url": "http://127.0.0.1:8791",
  "tokenEnv": "OAI_DSH_ADAPTER_TOKEN"
}
```

## Android 设备能力安全说明

- DSH Agent 若需操控 Android 设备，必须使用 OAI Core CLI/MCP/API 并在当前操作主体明确授权的会话下进行。
- DSH 原生会话属于共享空间，但 Android 设备授权仍按 OAI 账号独立。
- 不得让共享 DSH 进程继承某个 OAI 账号的长期设备 Token。
- 不得让所有 DSH 会话共享同一份私人 OAI CLI 配置。
- 不得以会话桥 Token 代替设备权限。

## 旧数据兼容与回滚指南

1. **旧数据保留**：
   - 升级到 0.3.0 适配器不会删除或覆盖 DSH 原生会话历史数据。
   - 历史旧 Gateway 的 SQLite 数据库（位于 `$DSH_HOME/dsh-android-gateway/`）已被保留，不会自动清除。
2. **端口冲突防范**：
   - 旧 Gateway 复用 DSH Web 端口路由 `/open-android-intelligence/v2/*`；
   - 新 Adapter 默认独立监听回环端口 `127.0.0.1:8791`（可通过 `port` 配置），不争用 Web 端口。
3. **回滚方案**：
   - 若需回滚到旧独立 Gateway，可通过 git 切回 `0.2.0` tag/提交，重新构建并安装 bundle。
   - 旧账号库与凭据依然保持原样可用。

## 开发与测试

```bash
npm test              # 运行适配器单元测试
npm run typecheck     # TypeScript 类型检查
npm run verify:upstream # 校验与上游 open-android-intelligence 参考实现一致性（防代码漂移）
```
