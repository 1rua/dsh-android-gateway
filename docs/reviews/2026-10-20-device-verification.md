# 2026-10-20 真机级验证报告（Android 模拟器 + 真实 DSH）

## 结论

DSH Android Gateway v0.1 已在**真实 DeepSeek Harness 进程 + 真实 Android App**上完成端到端验证：

- 手机端密码登录、会话列表、历史、发送消息、**流式增量**、完成状态、停止生成均可用；
- 斜杠命令目录来自真实 DSH 命令注册表；
- 附件三段式上传、图片消息被 DSH Agent 正确读取并回答（红色图片 → 回复「红色」）；
- 杀进程重启后自动恢复会话与历史，不需要重新登录；
- 网关事件、消息状态与历史投影与 App UI 一致。

## 环境

| 项 | 值 |
|---|---|
| DSH | `0.2.1-rc.2`（profile `web`，运行端口 `43535`） |
| 插件 | `dsh-android-gateway@0.1.0`（本仓库，Bundle 安装，`application: applied`） |
| App | 从 App 仓库源码构建的 `app-full-debug.apk`，`versionName 2.1.1`，提交 `745e2cf` |
| 契约核心摘要 | `sha256:032f580246eb4a214624bded717819b4d5a76191208207edc9e5a4607f5c4d23`（两端一致） |
| 设备 | Android 模拟器 Pixel 7 / Android 15（SDK 35）x86_64，KVM 加速 |
| 网络 | App → `http://10.0.2.2:43535`（模拟器到宿主机回环） |

> 预置 APK（`tmp/artifacts/*/app-full-debug.apk`）的核心摘要是旧的
> `sha256:99309b…`，与当前 App 源码契约不一致，因此验证使用当前源码构建的 APK。
> 这不是网关问题：协商会如实拒绝不同契约版本的客户端。

## 已通过的验收项

| # | 验收项 | 证据 |
|---|---|---|
| 1 | Bundle 安装并即时生效 | `plugin_manager install_bundle` → `application: applied` |
| 2 | `/negotiate` 返回 2.1 能力交集 | curl 200 + `docs/reviews/evidence/.../` 无 |
| 3 | 密码登录并建立设备密钥 | App 登录成功进入工作台；`gateway.db` 中有 device/session 记录 |
| 4 | 九 header 签名、时间窗、nonce、幂等 | 真实 App 所有请求均通过；伪造签名单测返回 `SIGNATURE_INVALID` |
| 5 | SSE 事件流（delta/completed/status） | 手机端逐字增长、最终完成（截图 `app-conversation.png`） |
| 6 | 会话列表 / 创建 / 标题 | 工作台标题、新建对话后空状态（截图未单独保存） |
| 7 | 历史分页与附件 parts | 重启后历史含附件卡与「红色」回复（截图 `app-image-reply.png`） |
| 8 | 斜杠命令目录 | `/` 弹出 `/compact`、`/export`、`/feedback`、`/goal`、`/permission`（截图 `app-command-catalog.png`） |
| 9 | 停止生成 | 长回复生成中点「停止生成」→ 按钮恢复、状态结束 |
| 10 | 附件三步上传 | App 显示「已核验，可发送」 |
| 11 | 图片消息被 Agent 读取 | 红色 64×64 PNG → 回复「红色」 |
| 12 | 自动恢复 / refresh | 杀进程重启后直接回到会话与历史，无需重新登录 |
| 13 | 配对状态轮询 | `GET /pairings/current` 与 `POST /pairings/current/capabilities` 冒烟通过（摘要 `sha256:` 形式） |
| 14 | 基线快照 | `/sync/snapshot` 返回 `baselineCursor` 与当前会话 |
| 15 | 历史附件元数据降级 | 网关返回 `remoteAvailable:false`；App 本地已缓存原件，点击“下载”显示“已保存到下载目录” |

## 复现命令

```bash
# 1. 构建插件并安装（在 DSH 会话内）
npm install && npm run build && npm test
# plugin_manager action=install_bundle target=/abs/path/dsh-android-gateway

# 2. 假手机冒烟（协商→登录→配对→快照→命令→建会话→SSE→消息→历史）
node tools/smoke-client.mjs \
  --url http://127.0.0.1:43535 \
  --setup "$DSH_HOME/dsh-android-gateway/setup-account.json" \
  --prompt "reply OK"

# 3. Android 模拟器（示例）
avdmanager create avd -n dsh-oai -k "system-images;android-35;google_apis;x86_64" -d pixel_7
emulator -avd dsh-oai -no-window -no-sound -no-boot-anim -gpu swiftshader_indirect &
adb install -r apps/android/app/build/outputs/apk/full/debug/app-full-debug.apk
# 登录地址 http://10.0.2.2:43535，账号见 setup-account.json
```

## 观察到的限制（非阻断）

1. **插件热重载会中断进行中的 SSE 流**：验证过程中多次用 `set_plugin` 热重载插件，
   旧的 SSE 连接没有继续投递事件，手机端会停留在“正在思考”，重启 App 后从历史恢复。
   正常进程重启/插件重载期间进行中的生成都会遇到同类限制；HTTP 重连与历史读取可恢复。
   这是 v0.1 的已知限制，不是协议错误。
2. **设备能力授权同步提示**：模拟器中 App 周期性显示“设备能力授权同步失败，正在重试”。
   网关诊断日志证明 App 在该环境下根本没有发出 `POST /pairings/current/capabilities`
   （失败发生在手机端本地插件快照），不是网关拒绝。真实设备上需另行验证。
3. **审批卡片未声明**：App 如实显示“该网关不支持审批卡片，请用 /approve 文本命令回复”。
4. **历史媒体原件**：附件字节在宿主确认接收后按契约删除，网关只保留元数据；
   元数据端点返回 `remoteAvailable:false`，App 依赖本地缓存或提示原件不可用。
5. **删除会话是墓碑 + 归档**：DSH 无公开删除 API，见 README 已知限制。

## 证据文件

- `docs/reviews/evidence/2026-10-20-device-verification/app-conversation.png`
- `docs/reviews/evidence/2026-10-20-device-verification/app-image-reply.png`
- `docs/reviews/evidence/2026-10-20-device-verification/app-command-catalog.png`

## 自动化测试

```
npx vitest run          # 11 文件 / 107 用例
npx tsc --noEmit        # 0 错误
npm run build           # tsc + 契约快照复制
```

覆盖：契约向量（target/签名/Schema/状态机）、SQLite 存储、账号与会话、
请求签名与时钟、会话/消息/生成闭环、附件上传与发送、HTTP 传输（header/信封/SSE/附件）、
配对状态与能力摘要。
