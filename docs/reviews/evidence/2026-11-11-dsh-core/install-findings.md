> 证据归档说明：为避免仓库全局 `*.log` 忽略规则，归档日志使用 `.txt` 后缀；下文原始 `/tmp/` 执行记录中的 `.log` 路径保留其历史含义。

> 归档说明：本分项按最初测试快照记录；最终 OAI dev 已复核至 24172841f9a564c53416f7d066f3450d4feb2bfe，行号修正及源码等价证据见 latest-delta.md，最终结论以主报告为准。

# DSH 安装、安全边界与多 Profile 子审计

审计快照：独立插件 `325a48058dafbfdb0686dc060e08674d8810b4c1`；OAI `dev` `d5b82cb6f796a08838f3a1136b8fbb77e22c0f49`；实际安装宿主 `@deepseek-ai/dsh 0.2.2-rc.1`。仅检查源码、已安装宿主包与合成数据；未读取真实凭据、私人会话或修改实际 Profile。

## 已确认并隔离复现：INSTALL-01（P1）Core 重启流程没有绑定所选 DSH Home / Profile

- **所属模块**：OAI Core 安装/配置管理；不是独立插件的消息实现缺陷。适用于独立与内置 Bundle 的安装后恢复。
- **源码**：`oai-core/src/oai_core/configuration.py:1484` 接受 `profile_home/profile_name`；`:1499` 重新发现所有 DSH Home，`:1505` 仅取首个 Home 所有者；`:1526-1535` 用固定 `dsh.service`、`dsh-web.service`、`dsh@web.service`、`deepseek-harness.service` 并重启第一个活跃单元，完全不核对所选 Profile / Home。`:1670-1684` fallback 仅以命令行含 `dsh` 和 `web` 判断，未核对所选目录与 Profile，即可 SIGTERM。`:1613-1615` / `:1704-1706` 重建命令只保留 Profile 名，未传入所选 DSH_HOME、原启动配置、参数和环境。安装选择存在于 `:1894-1905`，但 `_upgrade_dsh_bridge` 只返回布尔值，调用方 `:2036-2040` 直接无参重启；自动更新 `scripts_runtime.py:842-843` 虽传入目标，仍被 systemd 路径忽略。
- **触发条件**：多个 Profile 或多个 DSH Home / 用户服务并存；操作员选择 `target-home/worker`，而 `dsh.service` 为另一个正在处理会话的实例。
- **最小复现**：`PYTHONPATH=oai-core/src .venv/bin/python /tmp/dsh-audit-20261111/install/probe_restart_profile.py`。测试仅 Mock `subprocess.run` 和宿主发现，调用真实函数并显式传入 target-home / worker，合成 systemd 回报 active。
- **实际**：函数返回 True，执行目标为 `systemctl --user restart dsh.service`，整个调用未包含 target-home 或 worker。1 个缺陷复现断言通过，未执行真实 systemctl、信号或持久数据操作。
- **预期**：仅重启经核对属于所选 Home/Profile 的服务；无可验证映射时返回“不自动重启”，由用户明确重载该目标。
- **影响**：可能中断无关 DSH 的正在执行 turn，同时目标仍未加载新 Bundle；若绑定默认端口的是无关 Profile，同一默认实例 ID / 共享桥 Token 可使后续握手成功但连接到非用户所选实例。后一结果属于由配置组合产生的风险，未在真实多进程环境复现。
- **根因**：Profile 选择身份没有传递到重启与注册完整链路，进程发现使用模糊名称与固定服务名。
- **建议**：升级结果返回明确 `(home, profile, endpoint, service identity)`；使用经核验的 systemd `WorkingDirectory/Environment/ExecStart` 或保存的 launcher 身份，禁止扫描并杀死不相关进程；保留所选 DSH_HOME 与原命令；重启后以所选 instanceId / 端口握手确认。
- **验证**：两个不同 Home/Profile 的隔离服务运行，安装其中一个，断言另一个 PID/活跃 turn 不变；指定非 web Profile 并自定义 DSH_HOME，确认恢复到原目录和命令；注册最终身份对应所选实例。

## 已核对的安全与安装行为

1. 独立插件 `src/index.js:66-70,172-179,254-265` 以至少 32 字符的桥 Token、constant-time Bearer 比较、loopback 监听、HMAC challenge 应答隔离内部会话桥；没有 Android 配对、设备授权或账号凭据处理。设备权限仍由 Core / Android 负责。未发现桥 Token 可直接授权 Android 的证据。
2. `sessionScope=deployment` 是显式架构选择，不等于账号私有会话。Core 注册清单与握手均核对该字段（`agent_registration.py:181-190,211-225`），报告应将此作为部署共享会话的边界，不能把“账号之间可见同一 DSH 会话”本身认定为插件越权。管理员应只将可共享的 DSH 实例接入此 scope。
3. Core 自动生成桥密钥使用 `secrets.token_urlsafe(48)`，私有文件 0600，不覆盖已有文件；读取拒绝最终符号链接和宽权限（`agent_registration.py:94-151,154-163`）。配置同步写入 DSH `.env` 与 `.credentials.yaml`，保持其他字段（`configuration.py:2604-2681`）。本次未打开任何实际文件。
4. Core 的安装器使用明确 Profile，发现只遍历 Home/profiles 的直接子目录；处理无安装 Bundle 的首次目标需 `include_uninstalled=True`；安装前、备份前、子进程前重新校验管理权限与输入文件，拒绝符号链接/越界目录，备份目录 0700 文件 0600（`dsh_installation.py:58-172,175-181,197-245,287-369`）。
5. 内置安装 `install.mjs:275-284,335-352` 把旧 `dsh-android-gateway` 与新 `oai-dsh-session-adapter` 激活列表收敛为一个新 Bundle，同时保留旧依赖和其他 Profile/字段；因此正常由 Core 升级不会仅因包名不同而重复加载。两者插件 ID 都是 `oai-session-adapter`，手工同时激活仍应避免，但本次未制造真实重复激活，因此不报告已确认冲突 Bug。
6. 真实已安装 DSH 包确有 `@deepseek-ai/dsh-plugin-manager/operations` 的 `runProfilePnpm`、`@deepseek-ai/dsh-atomic-write` 的 `withFileLock/writeFileAtomic`、`@deepseek-ai/dsh-app-boot` 的 `readProfileManifest/writeProfileBundles`。官方 `operations.js:302-315` 明确调用者已持有写锁，故内置安装外层写锁不是重复加锁死锁。当前 API 与安装器使用一致；未执行真实包安装。
7. 安装器对官方 manager 返回 timeout/incompatible/非零码逐项处理，失败备份并校验恢复；不伪造成功、不输出子进程原始错误（`install.mjs:339-358`、`dsh_installation.py:248-284`）。现有 43 个 Node 安装测试及 69 个 Core 安装配置测试通过，属于隔离合约证据，不是实际宿主升级成功证据。

## 功能和验证边界

- 首次安装、旧 Bundle 升级、权限/输入变更防护、失败备份与回滚：已实现，隔离测试通过；真实 DSH 安装/更新未验证。
- 选择具体 Profile 安装：已实现，隔离测试通过；安装后目标重启存在 INSTALL-01。
- 多个 Profile 同时自动接入：自动发现最终只生成一份 `dsh` / instanceId `dsh` / `http://127.0.0.1:8791` 候选（`configuration.py:1288-1324`），同步所有 DSH Home 同一 Token。插件默认端口也为 8791。不是完整的多实例自动配置；可由管理员手工给各 Profile 设置独立端口、instanceId、tokenEnv 并注册多个 Agent，但这条手动真实链路未验证。归责 Core 管理/部署配置，插件 Config 已允许对应自定义。
- 卸载：Core 的 Bundle 安装助手未提供专门卸载接口；应由官方 `dsh plugin --profile <name> remove <package>` 与 Profile 激活管理承担。未操作真实配置，不把缺少独立卸载器认定为插件协议缺失。
- 热重载、DSH 重启、桥 Token 轮换自动恢复：代码路径存在部分支持，但未做真实运行验证；handler 创建时捕获 Token，文件变更后需要宿主重载/重启加载新环境，不能标为无缝轮换已验证。
- 隔离启动可行性：`dsh` 二进制已安装，宿主 `resolveDshHome` 支持显式 `DSH_HOME`；profile CLI 支持 `dsh --profile <name>`、额外 patch。建议主 Agent 创建全新测试 Home 并仅使用合成桥 Token，不挂载真实账号配置。模型请求若无独立测试凭据必须标记阻塞。

## 测试证据

所有执行文件均位于 `/tmp/dsh-audit-20261111/install/`，仅复制原有源码和测试，未修改生产代码。

| 测试 | 命令（在隔离目录） | 结果 | 日志 |
|---|---|---|---|
| 内置安装器 | `./node_modules/.bin/vitest run --config vitest.config.js` | 43 passed, 0 failed, 0 skipped | `install-node-tests.log` |
| Core 安装与配置 | `PYTHONPATH=<OAI>/oai-core/src <OAI>/.venv/bin/python -m pytest -q oai-core/tests/test_dsh_installation.py oai-core/tests/test_dsh_setup.py --basetemp=pytest-temp -p no:cacheprovider` | 69 passed, 0 failed, 0 skipped | `install-python-tests.log` |
| Profile 重启缺陷 | `PYTHONPATH=<OAI>/oai-core/src <OAI>/.venv/bin/python probe_restart_profile.py` | 1 缺陷复现通过 | `probe_restart_profile.log` |

Node runner 版本由现有 node_modules 提供 `Vitest 4.1.10`；Python pytest `9.1.1`。本次没有跑完整构建、CI 轮询或真实设备操作。
