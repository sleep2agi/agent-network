# 更新日志

::: info 版本号体系说明
本日志按时间倒序排列，**版本号经历过一次重新规划**：
- **2026-05 起**：采用 v0.6 → v0.7 → v0.8.x 渐进发布，对应 `commhub-server` semver
- **2026-04 之前**：曾使用 `v1.0.0-preview.N` / `v2.1` 等过度承诺型版本号，已废弃
- **当前 stable**：v0.8.3（2026-05-14，通过 npm `latest` tag 发布；v0.8.1 是 Apache 2.0 OSS 首发版本）
- 旧版历史保留作 git blame 完整性，详见下方 v1.0.0-preview / v2.1 / v0.x 段落
:::

## 🟡 v0.9.0 — **Recovery & Observability**（preview，2026-05-15）

> ⏳ **正在 promote 流程中**：preview tag 已发，stable `latest` 待 v0.9.0 promote 3 gate 全 pass 后翻牌。当前生产用户继续走 v0.8.3 stable，提前体验装 `@preview`：`npm install -g @sleep2agi/agent-network@preview`。

**Preview 版本号**（npm `preview` tag）：
- `@sleep2agi/agent-network@2.1.13-preview.6`
- `@sleep2agi/agent-node@2.3.6-preview.2`
- `@sleep2agi/commhub-server@0.8.1-preview.3`
- `@sleep2agi/agent-network-dashboard@0.4.6-preview.12+`

### 🎯 主题：Recovery & Observability

22 节点 reboot 后的**零键盘恢复闭环** + 默认 toolset 行为透明化 + 服务器级聚合观测。

### 新功能 — Recovery 链

- **`anet project up / restart / down`**（issue [#117](https://github.com/sleep2agi/agent-network/issues/117)）— cwd-wide 节点编排，扫 `.anet/nodes/` 全起 / 全重启 / 全停。共享选项 `--stagger <秒>`（默认 3 错峰）/ `--only a,b,c` / `--exclude x,y`。`down` 给 hub-offline 通知设 2s race timeout 防 hub 自挂场景拖死命令。
- **`anet node create --resume <id>` / `--resume-latest`**（issue [#115](https://github.com/sleep2agi/agent-network/issues/115)）— 创建节点时直接绑定已有 Claude session；TTY 模式下交互式 picker 列 `~/.claude/projects/<cwd>/*.jsonl`（age / size / 60-char 首行预览）。`anet session ls` 用同一份 `listClaudeSessions()` helper。
- **零键盘恢复机制**（[#115](https://github.com/sleep2agi/agent-network/issues/115)）— `anet node start` spawn `claude` 时自动注入 `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999`，跳过 Claude Code 默认 70min session-age 阈值的「Resume from summary / full / Don't ask again」交互弹窗；per-spawn 注入、不污染 `~/.claude/settings.json`、用户显式 export 覆盖；resume 还原完整 session（restart-recovery 不带意外 compaction）。
- **`anet node start` 默认 detached tmux**（issue [#122](https://github.com/sleep2agi/agent-network/issues/122)）— 4 条件同时成立才 wrap（TTY + `$TMUX` 未设 + 装了 tmux + 同名 session 不存在）。新 flag：`--foreground` / `--no-tmux`（互为别名）强制前台；`--attach` detached + 200ms grace + `tmux attach`。**两层递归保护**：`$TMUX` env 检测 + 内层 cmd 显式带 `--foreground`，保护 `anet project up` + 7 处 demo 内部调用。`anet node stop` 联动 `tmux kill-session` 先于 SIGTERM。
- **`anet upgrade` 4-包 + 双通道 + dry-run + self**（issue [#88](https://github.com/sleep2agi/agent-network/issues/88)）— 覆盖 `anet self` / `agent-node` / `commhub-server` / `dashboard`。Channel auto-detect（prerelease tag → preview，否则 latest）+ `--channel` 覆盖。`--dry-run` 只 print plan。`--self` opt-in detached spawn（默认 print 手动命令避免升级时替换运行进程）。Plan 行带 action badge：`upgrade` / `up-to-date` / `lazy via npx skip` / `self skip` / `lookup failed`。`commhub-server` 行恒显 `PINNED_SERVER_VERSION = 0.8.0` 提醒 `anet hub start` 跑 pinned 不跟全局走。
- **`anet.sh` install / upgrade scripts 同步**（issue [#123](https://github.com/sleep2agi/agent-network/issues/123)）— anet.sh 一键脚本与 npm 双通道对齐 + Node 22.13 engine 校验。

### 新功能 — Runtime 默认行为透明化

- **`claude-agent-sdk` 默认 Claude Code preset 全集**（issue [#101](https://github.com/sleep2agi/agent-network/issues/101) Option B）— 修了 root cause：`config.json` 无 `tools` 字段时 agent-node 设 SDK `options.tools = undefined` → agent 零内建工具 → 幻觉「网络受限」。改成 fallback 到 SDK `{ type: 'preset', preset: 'claude_code' }` sentinel，agent 默认获得 WebFetch / WebSearch / Bash / Read / Write / Edit / Glob / Grep / Task / NotebookEdit 等。`--tools "all"` 路由到同一 preset（去硬编码 8-tool 列表）。
- **行为披露 banner**（[#101](https://github.com/sleep2agi/agent-network/issues/101) Vincent 4927 push）— `anet node create` 成功后 print built-in tools + MCP tools + `dangerouslySkipPermissions=true` 警示 + restrict-tools / disable-auto-skip / inspect-current-set hint。`anet info <alias>` 显示 `tools:` + `flags:` 行供随时审计。
- **`anet ls -v` / `--verbose`**（同 [#101](https://github.com/sleep2agi/agent-network/issues/101) 配套）— 每节点多打一行 `tools=...  permGate=on/off`。

### 新功能 — Security hardening

- **Vendor token envRef 模式**（issue [#125](https://github.com/sleep2agi/agent-network/issues/125)，v0.9.0 P0 gate #2）— `config.json` env map 接受 tagged union：`string`（legacy，仍兼容，print 一次性 deprecation banner）或 `{ "_envRef": "VAR_NAME" }`（推荐，secret 留 process.env 永不落盘）。agent-node unset envRef 时**启动直接 FATAL exit** + remediation hint，refuse silent broken。
- **`anet node create` 自动 envRef rewrite** — `saveCreatedNode` 前跑 `rewritePlainSecretsToEnvRef()`：secret 识别启发式（key 后缀 `/_TOKEN|_KEY|_SECRET|AUTH$/` 或 value 前缀 `/sk-|utok_|ntok_|atok_|ak-|gsk_|key-|Bearer/`）任一命中就翻 envRef，原值塞当前 `process.env`（spawn 立即可用）+ print `export NAME='value'` 让用户抄进 `~/.bashrc`。
- **`anet node migrate-token-to-envref <alias>`** — 新命令，已有节点一键迁。备份原文件到 `config.json.bak-<ts>`，rewrite + print export 行；idempotent（非 secret + 已 envRef 不动）。
- **`anet doctor` enumerate plain-secret 节点** — passive 扫描 + 提示走 migrate 命令（不自动 `--fix`，per-node opt-in）。

### 新功能 — Observability

- **`GET /api/servers` REST endpoint**（issue [#119](https://github.com/sleep2agi/agent-network/issues/119)，server 11a3018）— 按 `hostname` + `ip` 聚合 agent + host 实时遥测，dashboard「服务器侧栏」用。返回**裸 JSON array**（非 `{ok, ...}` wrapper）。先 10min stale 标 offline 再聚合；`addNetworkScope` 网络作用域。字段：`hostname` / `ip` / `agent_count` / `cpu_load_1min` / `cpu_cores` / `mem_avail_gb` / `mem_used_gb` / `last_seen`。
- **agent-node host telemetry**（[#119](https://github.com/sleep2agi/agent-network/issues/119) step 1，5364931）— 每次 `report_status` 附带 host 字段。Linux `/proc/loadavg` + `/proc/meminfo` MemAvailable 优先；macOS/Win 兜底 `os.loadavg()` / `os.totalmem()` / `os.freemem()`；Windows `[0,0,0]` 主动 coerce `null`；10s cache 阻断 burst。
- **Dashboard ServersDrawer**（[#119](https://github.com/sleep2agi/agent-network/issues/119) step 3）— Web UI 侧栏展示按物理机聚合的 agent count + CPU / RAM 实时条。
- **Dashboard 拓扑图重做 + 38 轮持续 polish**（issue [#112](https://github.com/sleep2agi/agent-network/issues/112) + [#116](https://github.com/sleep2agi/agent-network/issues/116)）— grid / ring 双视图 + mount fade-in + hover ring focus + click ripple + label scale + arrow tier + offline dim + group-box hover + minimap + cwd tooltip 等 9+ 轮交互细化。

### 文档

- **GitHub README 门面级优化**（issue [#118](https://github.com/sleep2agi/agent-network/issues/118)，commit `2dd646d`）— Hero / Quick start / Demo / CTA 提前；anet vs LangGraph/AutoGen/CrewAI 5×4 对比表；信任信号 4-badge + Star History chart；mermaid 架构图 + 节点接入流程；ZH + EN 双语同步。
- **docs-site catch-up sweep**（issue [#124](https://github.com/sleep2agi/agent-network/issues/124)）— 把今日 ship 的所有新功能批量同步到 anet.sh：`cli.md` / `upgrade.md` / `security.md` / `rest.md` / `CHANGELOG.md` 全部 ZH + EN。

### Breaking changes / Migration

- ⚠ **`anet node start` 默认行为变化** — 从 v0.9 preview 起默认 wrap 进 detached tmux（v0.8 是前台跑）。脚本/CI 场景请显式 `--foreground` 或 `--no-tmux`。
- ⚠ **`claude-agent-sdk` 节点默认 toolset 变化** — 从空集变成 Claude Code preset 全集（含 Bash / WebFetch / Write 等）。已有节点显式 `tools` 列表保留原行为。新节点请确认是否需要 `--tools Read,Glob,Grep` 显式收窄。
- ⚠ **vendor secret 不再落 `config.json` 明文** — 新建节点自动走 envRef；已有明文节点跑 `anet node migrate-token-to-envref <alias>` 一键迁，过渡期 plain string 仍兼容（deprecation banner 提醒）。
- ✅ **Preview 版本号规则**（[Vincent push](https://github.com/sleep2agi/agent-network/issues/126)）— preview chain 内升 `-preview.N+1` 后缀，**不升 patch 重置 preview.0**，避免版本号「倒退看起来像 downgrade」。

### Smoke validation 必跑（promote 前）

```
1. plain fallback           — 旧 config 含 "sk-..." 仍能启动 + 显示 deprecation banner
2. envRef happy path        — { _envRef: "TEST_TOKEN" } + export TEST_TOKEN=fake → 节点拿到正确 token
3. envRef missing var FATAL — #2 不 export → 启动 FATAL + remediation hint
4. anet doctor 扫描         — 混合 plain + envRef 节点 → 只 plain 入 warning
5. migrate 幂等            — plain → migrate → 再跑无 op + `.bak-<ts>` 存在 + export 行打印
6. anet node create 自动    — `--env ANTHROPIC_AUTH_TOKEN=sk-fake` → config.json 是 envRef，不是字面 sk-fake
```

详见 [issue #125](https://github.com/sleep2agi/agent-network/issues/125#issuecomment-4457630036) 完整可复现步骤。

---

## 2026-05-14 — **v0.8.3 正式版** batch primitive + 多 demo + P0/UX 修复 ✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.1.9`
- `@sleep2agi/agent-node@2.3.1`
- `@sleep2agi/commhub-server@0.8.0` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.4.5`

> 注：agent-network 2.1.8 因早先 stale build 占位跳过，正式版为 2.1.9。

### 新功能

- **`anet create --batch` 批量 agent 原语**（issue [#55](https://github.com/sleep2agi/agent-network/issues/55)）— 一行起 N 个带身份的 agent，`--prefix` 自动编号，每节点独立工作目录 + config + tmux session；配套 `anet batch <verb>` 统一管 lifecycle（list/stop/cleanup/start/restart）。
- **`anet demo sci-team`**（issue [#51](https://github.com/sleep2agi/agent-network/issues/51)）— 科研军团 demo：1 leader + N-1 worker 主动 fan-out 协作。
- **`anet demo pr-review`**（issue [#41](https://github.com/sleep2agi/agent-network/issues/41)）— 4-agent PR review room demo。
- **`anet login` 首次登录引导**（issue [#58](https://github.com/sleep2agi/agent-network/issues/58)）— 认证失败时给出 register / 默认账号 / hub admin reset-user 指引。
- **claude-agent-sdk 模型 dropdown 增加 verified vendor presets**（issue [#48](https://github.com/sleep2agi/agent-network/issues/48)）— MiniMax + 书生 Intern。
- **SDK 升级** — codex-sdk / claude-agent-sdk / inquirer 依赖升级。

### 修复

- **batch 节点身份注入**（issue [#93](https://github.com/sleep2agi/agent-network/issues/93)，P0）— batch 创建的节点之前不知道自己的 alias；现在 per-node 注入身份前缀。
- **`anet hub dashboard` npx 缓存自愈**（issue [#89](https://github.com/sleep2agi/agent-network/issues/89)，P0）— spawn 前自动清理 stale staging dir。
- **`anet hub dashboard` release channel 匹配**（issue [#61](https://github.com/sleep2agi/agent-network/issues/61)）— dashboard 版本号改为按 anet channel 动态匹配。
- **`anet init` token prompt UX + session 计数**（issue [#56](https://github.com/sleep2agi/agent-network/issues/56)）。
- **进程 spawn 移除 shell**（issue [#36](https://github.com/sleep2agi/agent-network/issues/36)）— 消除 command injection 面。
- **claude-agent-sdk env 注入 + timeout guard**（issue [#98](https://github.com/sleep2agi/agent-network/issues/98)，部分修复）— config.json env 块在 `--config` 启动路径正确注入；claude 调用加 wall-clock timeout guard，hang 变可见超时错误。
- **PINNED commhub-server → 0.8.0 stable**。

### 包变更明细

- **agent-network** 2.1.7 → 2.1.9（13 个 preview 迭代累积）
- **agent-node** 2.3.0 → 2.3.1 — claude-agent-sdk / codex-sdk 依赖升级 + #98 修复
- **commhub-server** 0.8.0 *(无变化)*
- **agent-network-dashboard** 0.4.2 → 0.4.5 — 三环 layout / alias 头像 / 全屏 zoom / 前缀分组 / 书生头像 / 标签遮挡修复 / trial badge 删除

---

## 2026-05-12 — **v0.8.2 正式版** telegram channel + claude-code-cli session resume ✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.1.7`
- `@sleep2agi/commhub-server@0.8.0` *(无变化)*
- `@sleep2agi/agent-node@2.3.0` *(无变化)*

**关联**：issue [#13](https://github.com/sleep2agi/agent-network/issues/13) (closed) · issue [#14](https://github.com/sleep2agi/agent-network/issues/14) · commit [143b2a1](https://github.com/sleep2agi/agent-network/commit/143b2a1) (`release: 2.1.7 stable`) · commit [f1e3d9c](https://github.com/sleep2agi/agent-network/commit/f1e3d9c) (`fix(cli): bind claude code sessions on first start`)

### 新功能

- **`anet channel add telegram` 一键接入** — 给已有 node 绑定 Telegram bot token + allow user，自动生成 channels/telegram 配置（细节见 [cases/telegram-squad](/cases/telegram-squad)）。

### 修复

- `claude-code-cli` runtime 创建节点时预生成 Claude session UUID。
- 首次启动使用 `claude --session-id <uuid>` 绑定固定 session；检测到本机已有 `~/.claude/projects/<cwd>/<uuid>.jsonl` 后改用 `claude --resume <uuid>` 续会话，避免 `anet node start` 误开新对话。
- `anet node start --new-session` 会生成并保存新的 session UUID。

---

## 2026-05-11 — **v0.8.1 补丁** Dashboard SSE-online 全局修补 ✅ stable

**版本同步**（npm `latest` tag，git tag `v0.8.1`）：
- `@sleep2agi/commhub-server@0.8.0` *(无变化)*
- `@sleep2agi/agent-network@2.1.5`
- `@sleep2agi/agent-network-dashboard@0.4.2`
- `@sleep2agi/agent-node@2.3.0` *(无变化)*

### 修复

- Dashboard `/nodes`、`/admin`、`/api/hub/session` 三处都因为 SSE key 在 v0.7+ 改成 `network_id:alias` 而显示所有 agent 为 offline。0.4.1 的 fix 漏了这 3 处，0.4.2 补齐全局 sse 查询的 alias-fallback 模式。
- CLI 同步 bump `PINNED_DASHBOARD_VERSION` 到 0.4.2，否则 `anet hub dashboard` 仍拉老版。

---

## 2026-05-11 — **v0.8.0 正式版** 🎉 RFC-001 阶段 2 落地 ✅ stable

**版本同步**（git tag `v0.8.0`）：
- `@sleep2agi/commhub-server@0.8.0`
- `@sleep2agi/agent-network@2.1.4`
- `@sleep2agi/agent-network-dashboard@0.4.1`
- `@sleep2agi/agent-node@2.3.0` *(无变化)*

### 鉴权变化

- `COMMHUB_AUTH_TOKEN` 进入软废弃：v0.8 只保留 `/api/*` 读类兼容并打印 warning，v1.0 移除。
- `anet hub start` 首次启动 bootstrap 默认 admin 账户（`admin / anethub` 快速上手默认），把本机恢复用 admin `utok_` 写到 `~/.anet/server/admin-utok.json`（`chmod 600`）。**公网部署立刻 `anet passwd` 改强密码**。
- 第二次起 `anet hub start` 是 idempotent：admin-utok.json 已存在直接跳过 bootstrap，不再 prompt。
- Dashboard 改为浏览器 cookie 透传（thin proxy 起步，完整 0-token 模型留 v0.8.x 后续）。
- tmux / admin 端点强制 admin `utok_`。

### 密码管理

- `anet passwd` 默认交互输入旧密码、新密码、确认密码；保留 `--old` / `--new`。
- 改密成功后当前设备换新 `utok_`，其他设备 `utok_` 自动失效；Agent `ntok_` 不受影响。
- 新增 `anet hub admin reset-user --username <u>`，仅 hub 主机本机恢复普通用户密码，写入 `password_reset_by_admin` 审计事件。
- 用户自选密码最小长度 8 + top-1000 弱密码字典；首次 bootstrap admin 的默认密码不受此限制（≥ 4 即可）。

### Doctor 大幅增强

- `anet doctor --fix` 现在会**主动 probe 每个 node 的 ntok_** 是否被 hub 接受。401/403 自动从当前 utok_ 重新颁发 ntok_，**in-place patch 文件**，session_id / channels / runtime / role 全部保留。这覆盖了"hub DB 被 wipe / token 被撤销" 场景。

### CLI / UX

- `anet hub start` 默认 silent auto-generate，不再 prompt 中断启动。
- `anet login` 输出加 ✅ + 下一步提示；prompt 文案去掉重复冒号 bug。
- 命令行错误信息从 `[anet]` 平淡前缀改为 ✅ / ❌ 视觉标识。

### Dashboard 0.4.1

- 修 Command Mesh 的 `sse:undefined`：SSE key 在 server v0.7+ 改为 `network_id:alias`，dashboard 同步按双层 key 查询，带 alias-only fallback 兼容老 hub。
- light/mint 主题 solid button 修补（从 0.3.4 起）。

---

## 2026-05-10 — **v2.1 正式版** 🎉

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.1.0`
- `@sleep2agi/commhub-server@0.6.0`
- `@sleep2agi/agent-node@2.3.0`
- `@sleep2agi/agent-network-dashboard@0.3.0`

::: tip 安装
```bash
npm install -g @sleep2agi/agent-network
```
不需要再加 `@preview`，默认就是新正式版。
:::

### 这一波带来什么

**🩺 `anet doctor --fix` 自动迁移老 V2 节点**
来自一线踩坑：claude-code-cli runtime 路径上很多 V2 时代的 node config（带 `alias`/`resume`/没 token / hub URL 是 dev IP）跑 V3 hub 直接报 `utok_ but SSE needs ntok_`。doctor 现在能：
- 检测 6 类老 config 问题（字段重命名、runtime 改名、stale hub、缺 token、无前缀 token、缺 node_id）
- 一键 `--fix` 升级，**保留 session 字段不丢对话历史**，重新申请 ntok_

**🪄 `anet demo` 子命令族**
- `anet demo ls` — 列出 demo
- `anet demo debate` — 6 agent 9 步辩论赛
- `anet demo socialmedia` — 4 agent 社交媒体内容工厂（小红书/Twitter/微信/LinkedIn）
- 默认建独立 `demo-<suffix>` network 跑完自动清场，**不污染 default**

**🔧 hub telemetry 修复**
- `POST /api/task` 现在双写 inbox + tasks 表（之前只写 inbox 导致 dashboard Tasks 页空 + send_reply 找不到 task）
- 派任务时立即 UPDATE sessions.task + updated_at（dashboard Overview 实时反映"任务在飞"）

**🎨 dashboard 多主题**
- 4 个主题：Cyber（默认深色）/ Light / Mint / Sunset
- 右下角切换，localStorage 持久化
- 修复 `useSSE` 死循环（之前 hub 收 1500+ admin SSE 把 mcp 拖死）
- 默认 `COMMHUB_URL` fallback 改回 `127.0.0.1:9200`（之前是 leftover dev IP）

**🛠️ CLI**
- `--runtime http-api` 不再错走 claude CLI 分支
- agent-node HTTP runtime 同时识别 `ANTHROPIC_AUTH_TOKEN`（之前只读 `ANTHROPIC_API_KEY`）
- demo 子命令调 createCommand 时不再触发 6 次 "选择 provider" 交互弹窗

**📦 一键部署脚本**
- `hub-only.sh` 重写：4G swap + sudoers NOPASSWD + enable-linger + systemd autostart + AUTOSTART=1
- `agent-only.sh` 同步更新

### 升级路径

```bash
# 1. 升级 CLI
npm install -g @sleep2agi/agent-network    # 或 npm update -g

# 2. 重启 hub（让新 commhub-server 生效）
# tmux 起的: tmux kill-session -t hub; tmux new -d -s hub 'anet hub start'
# systemd-user 起的: systemctl --user restart anet-hub

# 3. 每个老项目目录跑 doctor --fix
cd <project-dir>
anet doctor --fix

# 4. 重启 agent
kill <claude-pid> && anet resume <node-name>
```

详细见 [升级指南](/guide/upgrade)。

---

## 2026-05-03 — `anet demo` 子命令族 + 多个 bug 修复

**版本同步**：anet@2.0.3-preview.4 / agent-node@2.2.0-preview.1 / dashboard@0.2.1-preview.1 / commhub-server@0.5.3-preview.0

### 新功能

- **`anet demo ls`** — 列出可用 demo
- **`anet demo debate`** — 一键 6-agent 辩论赛（主持人/正反 4 辩/评委）
  - `--topic "议题"` 议题（默认交互输入）
  - `--key sk-cp-xxx` MiniMax API key（默认 `$MINIMAX_KEY`）
  - `--quick` 4 步简化版（默认 9 步完整版）
  - `--keep` 跑完保留 6 个临时 agent（默认清掉）
  - `--out path.md` 实录路径
  - 角色个性独立 systemPrompt，跑完输出 markdown 实录
- **`anet demo monitor`**（旧 `anet demo --live` 别名保留）

### Bug 修复

- **anet CLI**：`--runtime http-api` 在 `node start` 时错走 claude CLI 分支 → 改为 spawn agent-node 并显式传 `--runtime`
- **agent-node**：HTTP runtime 加读 `ANTHROPIC_AUTH_TOKEN` env（之前只读 `ANTHROPIC_API_KEY`，导致 MiniMax 配置无法工作）
- **dashboard**：`useSSE` 钩子的 `connect` callback 依赖 `onEvent`，调用方传内联函数导致每次 render 都 reconnect → 用 ref 包装 `onEvent`（修复了"hub 收 1500+ admin SSE"的死循环）
- **hub-only.sh** 一键脚本重写：自动加 4G swap、配 sudoers NOPASSWD、enable-linger、systemd --user 自启（`AUTOSTART=1` 启用）

---

## 2026-04-30 — Parent Task Lineage + Auto-Chain Reply

**commhub-server@0.5.3-preview.0**

修复多 agent 链式调用断链问题：admin → 指挥室 → 主编 时，指挥室 reply 后会话结束，主编返回结果时找不到 admin。

- `tasks` 表加 `parent_task_id` 列 + `chainReplyToParent()` helper
- `send_task` 接受 `parent_task_id`（缺失时根据 caller 最近一个 open task 推断）
- `send_reply` / `report_completion` 自动沿 parent 链向上转发结果
- agent-node 自动注入 `CURRENT_TASK_ID` env，prompt 提示 LLM 必须传 `parent_task_id`

---

## 2026-04-26 — Hub Server Logs Page + V2 Lineage Foundation

**commhub-server@0.5.2-preview.0 / dashboard@0.2.1-preview.0 / anet@2.0.3-preview.1**

- Dashboard 新页面 `/server-logs`：实时查看 hub stdout（最近 N 行 ring buffer）
- REST `GET /api/server-logs`（admin 鉴权）
- Hub banner & `/health` 显示真实 published 版本号

---

## 2026-04-15 — V3 Stable: Multi-Network + User System + Trial License

**Agent Network V3 — Multi-Network + Commercial Ready**（commhub-server 0.5.x、anet 2.0.x）

主要交付：
- **多网络支持**：每个网络隔离 nodes/tasks/sessions
- **用户系统**：用户名+密码注册/登录、JWT、双 Token 体系（utok_ + ntok_）
- **试用授权**：14 天免费试用，授权码激活 Pro
- **39 CLI 命令**：quickstart、login、register、passwd、token、network (CRUD)、status、tasks、doctor、info、logs、demo、config、license、activate、hub start...
- **17 MCP 工具**：send_task/send_reply/retry_task/cancel_task/reassign_task/list_tasks/get_task/...
- **17 REST 端点**：/api/auth/* + /api/networks/* + /api/tasks + /api/nodes + /api/stats + /api/audit-log + /api/license + ...
- **3 种 Runtime**：claude-agent-sdk、codex-sdk、http-api（OpenAI/MiniMax 兼容）
- **审计日志** + **速率限制** + **PostgreSQL 支持**（DbAdapter 接口）

测试：200+ Docker E2E 回归测试覆盖（认证、网络、隔离、token CRUD、SSE 并发、审计）。

---

## v1.0.0-preview.25 (2026-04-11)

### PostgreSQL + Adapter Architecture

**新功能**：
- **PostgreSQL 支持**：`DATABASE_URL=postgres://...` 启用 PostgreSQL（SQLite 仍为默认）
- **DbAdapter 接口**：统一数据库抽象层（SQLiteAdapter + PgAdapter）
- **SQL 自动翻译器**：`sqliteToPostgres()` 处理 datetime->NOW、?N->$N、AUTOINCREMENT->SERIAL
- **34 个 CLI 命令**：新增 passwd、token (create/ls/revoke)、network (info/rename/delete)、demo、config、license、activate、hub start
- **17 个 REST 端点**：新增 PUT /api/networks/:id、DELETE /api/networks/:id、POST /api/auth/password、token CRUD
- **一键 Demo**：`bash examples/demo-one-click.sh` -- 60 秒自动化演示
- **createAdapter() 工厂**：环境驱动的数据库选择

**架构改进**：
- 全部 85+ 个 `db.query()` 调用迁移到 adapter 方法（`db.get()`、`db.all()`、`db.run()`）
- 全部 7 个手动 `BEGIN/COMMIT/ROLLBACK` 事务转换为 `db.transaction()`
- 零原始数据库访问 -- 所有代码通过 `DbAdapter` 接口
- SQL 翻译器处理 4 个源文件中的 161 个 SQL 片段

**测试**：
- 200 个 Docker E2E 测试（137 基础 + 25 认证 + 22 网络 + 16 配置）
- 19 个 adapter 专项 E2E 测试
- 10 个 SQL 翻译器单元测试

---

## v1.0.0-preview (2026-04-10)

### Agent Network V3 -- Multi-Network + Commercial Ready

**新功能**：
- **多网络支持**：创建隔离的网络，每个有独立的 nodes/tasks/sessions
- **用户系统**：用户名+密码注册/登录、API Token 认证
- **试用授权**：14 天免费试用，授权码激活 Pro
- **39 个 CLI 命令**：quickstart、login、register、passwd、token、network (create/ls/use/info/rename/delete)、status、tasks、doctor、info、logs、demo、config、license、activate、hub start...
- **17 个 MCP 工具**：send_task、send_reply、retry_task、cancel_task、reassign_task、list_tasks、get_task...
- **17 个 REST 端点**：/api/auth/*、/api/networks/*、/api/tasks、/api/nodes、/api/stats、/api/audit-log、/api/license...
- **2 种 AI Runtime**：codex-sdk (OpenAI Codex / GPT-5)、claude-agent-sdk (Claude / MiniMax / OpenAI 兼容)
- **审计日志**：所有用户操作 + 任务状态变更记录
- **速率限制**：注册 30/min、登录 10/min per IP

**安全**：
- MCP/SSE/WebSocket 认证
- Server 端强制 network_id（token 绑定，客户端不可覆盖）
- SQL 注入修复（全部参数化查询）
- 网络所有权检查（跨用户访问 403）
- 密码哈希（SHA-256）
- localhost 免速率限制（开发/测试）

**数据库（13 张表）**：
sessions、inbox、tasks、nodes、completions、task_events、users、networks、api_tokens、audit_log、licenses、network_members、network_invites

**测试（200 个回归测试）**：
- 基础 E2E：137 个测试（节点生命周期、消息生命周期、认证、授权、SSE、并发）
- 认证套件：25 个测试（注册、登录、token、profile、密码、审计、速率限制）
- 网络套件：22 个测试（CRUD、隔离、所有权、重命名、删除、跨用户）
- 配置优先级：16 个测试（CLI > env > project > global）
- 真实 AI：Codex (GPT-5) + MiniMax (Anthropic API) 验证
- 10-agent 成语接龙（混合 codex + minimax）

**npm 包**：
- @sleep2agi/agent-network (anet CLI)
- @sleep2agi/agent-node (Agent 运行时)
- @sleep2agi/commhub-server (通信中枢)

---

## v0.x (2026-03 ~ 2026-04-09) -- Pre-V3

### 核心功能建设

- **CommHub Server**：基于 MCP + SSE 的通信中枢
- **agent-node**：双引擎 Runtime（Claude + Codex）
- **anet CLI**：create / start / resume / channel 等基础命令
- **Dashboard**：基础版本
- **消息类型**：task / reply / message / ack 四种类型区分
- **Channel 插件**：Claude Code 接入 CommHub

### 早期里程碑

| 版本 | 日期 | 内容 |
|------|------|------|
| v0.1 | 2026-03 初 | 基础 CommHub + SSE |
| v0.3 | 2026-03 中 | agent-node 双引擎 |
| v0.5 | 2026-03 末 | anet CLI + Channel |
| v0.7 | 2026-04 初 | Dashboard + 消息类型 |
| v0.9 | 2026-04-09 | 多模型支持（MiniMax、书生） |

---

## 未来规划

### v0.9 -- 安全硬化
- 密码哈希升级到 Argon2id（当前 SHA-256）
- `utok_` / `ntok_` TTL + revoke-all
- 安装脚本 checksum 校验
- Dashboard 完整 0-token 模型收尾

### v1.0 -- 清理 + 公开网络
- 完全移除 `COMMHUB_AUTH_TOKEN` 兼容路径
- Token scope (full/agent/readonly) 完整实现
- 公开 / 邀请混合网络（member 申请 + owner 审批流）
- Dashboard 按角色精细化按钮可见性

### 后续探索
- ~~可选 PostgreSQL 后端~~ — adapter 接口保留作扩展点，**v0.8+ 产品方向已转为 SQLite only**（见 [docs/v3-postgresql-design.md banner](https://github.com/sleep2agi/agent-network/blob/main/docs/v3-postgresql-design.md)）
- SSO 集成
- Webhook 回调
- 任务调度（cron）

## 下一步

- [升级指南](/guide/upgrade) — v0.7 → v0.8 行为变化 + 标准步骤
- [架构概览](/guide/architecture) — 各版本是怎么累积成现在这套系统的
- [GitHub Releases](https://github.com/sleep2agi/agent-network/releases) — 每个 git tag 的 release notes
- [RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) — v0.8 ~ v1.0 master token 废弃路线图
