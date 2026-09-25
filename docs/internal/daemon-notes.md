> 2026-09-25 从用户文档 `docs-site/docs/deploy/daemon.md`（及英文版）移出的内部材料：版本对照、实测记录、证据与维护约束。用户页现为 `/deploy/daemon`（`anet daemon`）与 `/deploy/keep-alive`（Hub 常驻）。

# `anet daemon` / Hub 常驻：内部记录

## 1. 5 分钟体验的实测来源

原页「5 分钟体验」一节的每条命令在干净的 `node:22-bookworm-slim` 容器里实跑过（2026-08-27），
贴的是真实输出。当时的版本组合：

| 包 | 版本 |
|---|---|
| `@sleep2agi/agent-network`（anet） | `2.3.0-preview.47` |
| `@sleep2agi/agent-node` | `2.5.0-preview.34` |
| `@sleep2agi/commhub-server` | `0.9.0-preview.30` |

用户页已把输出里的 node_id、network_id、bootstrap 密码换成占位符。随机 bootstrap 密码自
`2.2.22-preview.4` 起（原页写在横幅说明里，用户页删去了版本号，因为 `anet daemon` 的下界 `.39` 已高于它）。

## 2. `anet daemon` 在哪些版本上存在 —— 版本对照

原页这一格曾经写反：它写「`anet daemon` 只在 `preview` 通道上存在，`latest` 会报 `Unknown command`」。
那是 2026-08-18 对当时的 `latest`（`2.2.21`）量出来的；之后两个前提都不再成立。于是用户页改成
只写下界、不写通道。

| 版本 | `anet daemon` | 依据 |
|---|---|---|
| `2.2.21` | `Unknown command "daemon"` | 2026-08-18 实测（当时的 `latest`） |
| `2.3.0-preview.39` | `Usage: anet daemon <subcommand> …` | 2026-08-18 实测（当时的 `preview`） |
| `2.3.0-preview.47` | `Usage: anet daemon <subcommand> …` | 2026-08-27 实测，且它是当天的 `latest` |

上表是实测过的点，不是完整边界：`2.2.21` 与 `.39` 之间具体哪一版引入没有逐个二分。

教训：别把「`latest` 有没有」写进文档。`latest` 指向会变，把结论钉在通道上，几天后就要再改。

### 用户页新增的下界及其来源（2026-09-25 核对）

| 用户页写的下界 | 来源 |
|---|---|
| `anet daemon list` 创建能力行 ≥ agent-network `2.3.0-preview.70` | `docs/tests/release-v2.3.0-preview.70.md`（#1545 整条链，#1565 为 list 输出；`.69` 缺子路径导出） |
| `anet daemon restart` ≥ `2.3.0-preview.73` | #1601 合入提交 `3371eabc` 时 `agent-network/package.json` 为 `2.3.0-preview.73` |
| `node start` / `node restart` / `project up` 起 daemon 也钉 pin ≥ `2.3.0-preview.110` | `docs/tests/release-v2.3.0-preview.110.md` 第 7 行（#1976，Refs #1353） |
| 原生 Windows 上 daemon 子命令直接拒绝 ≥ `2.3.0-preview.52` | `docs/tests/release-v2.3.0-preview.52.md`「Windows 上 `anet daemon` 仍被显式拒绝（#1290）」；引入提交 `37e0662e`（2026-08-28 +0800）。未对 `.51` 产物二分，`.52` 是保守下界 |
| 创建能力带测量时间 ≥ agent-node `2.5.0-preview.55` | `agent-network/src/daemon-capability-display.ts` 注释：`.54` 产物里没有 `create_capability_observed_ms_ago`，`.55` 有 |

npm 通道在 2026-09-25 的指向：`latest = 2.3.0-preview.76`，`preview = 2.3.0-preview.115`。因此
`#1353` 的 node-start pin（`.110`）当日**不在** `latest` 里；原页未带版本地描述它，读起来像 `latest` 已具备。

## 3. 让 daemon 在后台活下去 —— 三台真机实测（2026-08-27）

三条配方在三台真机（Linux 中继机 / macOS / Windows）上逐台跑通，每条都用「断开会话后再查 hub 心跳」验证，
不是看启动横幅。对应 `release-v2.3.0-preview.51` 的 #1285「daemon 常驻文档（三平台配方）」。

### Windows 配方（已从用户页删除）

原因：`2.3.0-preview.52` 起 CLI 在原生 Windows 上直接拒绝 `anet daemon init/start/up/restart`
（`agent-network/bin/cli.ts` 的 `prepareDaemonAnetBin`），下面这条配方在当前版本上已不能用。留档：

```powershell
# ✗ Start-Job：SSH 会话结束时连同 Job 一起被回收，daemon 静默消失
# ✓ WMI 创建进程：脱离会话树
Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
  -Arguments @{ CommandLine = "C:\Users\<you>\start-daemon.bat" }
```

```bat
@echo off
cd /d C:\Users\<you>
anet daemon start <name> >> C:\Users\<you>\daemon-<name>.log 2>&1
```

- 要用 `.bat` 包装：把带引号和重定向的长命令行直接交给 WMI 会返回 `ReturnValue=21`（参数非法）。
- SSH 登录的 cwd 可能不是 `C:\Users\<用户名>`：账号名与 profile 目录名不一定相同，导致
  `Daemon "<name>" not found`。

### Windows 与 #1290

原页 §5 写「Windows 上创建节点必失败（注册、心跳、`ok:true` 全正常）」并链 #1290。#1290 现为 CLOSED，
当前行为是 CLI 在启动前就拒绝，不再出现「在线但建不了节点」的欺骗性症状。用户页改为「只支持 Linux / macOS，
Windows 用 WSL」。

## 4. daemon 工作区 —— 规格与实现的差异

- RFC-026 规定 `workDir` 固定在 `~/.anet/daemon/workspaces/<network_id>/`；当前实现取 `process.cwd()`。
  差异与三条改法见 #1722（OPEN）。
- 代码位置：`agent-node/src/runtime/start-daemon.ts` 里
  `const nodesRoot = deps.nodesRoot ?? join(deps.workDir, ".anet", "nodes");`
  （原页引用时漏了 `deps.nodesRoot ??`）；创建路径在 `create-node-daemon.ts`
  `join(deps.workDir, ".anet", "nodes", req.node_spec.name)`。
- 原页引用 #1648 作为「真实形状」：一台机器上 daemon 在线、cwd 是用户主目录，而三个离线节点的
  `project_dir` 分别在两个别的盘符和一个 WSL 路径里。#1648 的标题是另一件运维事件（节点批量下线），
  且涉及其他团队的节点，不适合作为用户文档的外链，已从用户页删除。

## 5. `min_uptime` 实测

PM2（`node:22-bookworm-slim` 容器）守护同一个「30 秒后失败退出」的脚本，观察 100 秒约 3 个周期：

| `min_uptime` | `restarts` | `unstable restarts` |
|---|---|---|
| `20000` | 3 | 0（退避从不触发） |
| `45000` | 3 | 3 |

- `deploy/hub/ecosystem.config.cjs` 与 `deploy/dashboard/ecosystem.config.cjs` 都因此从 `20_000` 对齐到 `45000`
  （两者的启动脚本失败路径都是 `sleep 30`）。
- 本仓当前取值的复核：#1223。

## 6. 本仓生产配置与部署副本

- Git 权威在 `deploy/`：`deploy/hub/ecosystem.config.cjs`、`deploy/hub/hub-daemon.sh`（四道 fail-closed 预检：
  bun / 固化安装 / vault 密钥 / 端口占用）、`deploy/fleet/`（开机自启的 systemd user unit 与启动链）、
  `deploy/hub/README.md`（Hub 换版本流程，已演练）。
- 生产机 `~/.local/bin/` 下是部署副本，两边要一起改；漂移用 `deploy/check-deployed-copies.sh` 检。
- 用户页只保留「`deploy/hub/` 可作加固参考」一段，不再描述生产机布局。

## 7. 其它从用户页删去的叙述

- 原页标题「让 Hub 常驻：进程守护」却以 `anet daemon` 开篇，两件事名字撞车；2026-09-25 拆成两页。
- 「`anet daemon list` 只读本机配置」在 #1567 前与工具行为相反，#1565 起它会向 hub 询问创建能力。
- `anet daemon list` 的创建能力输出目前只有中文文案（`agent-network/src/daemon-capability-display.ts`）；
  英文页按「以什么开头」解释，没有编造英文输出。
- 原页「不要用 `bunx`/`npx` 当守护入口」的理由是「`/tmp` 被清空后再也起不来」。`anet hub start` 本身就用
  `bunx --bun @sleep2agi/commhub-server@<PINNED_SERVER_VERSION>` 启动 Server（`cli.ts` 唯一 spawn 点），
  bunx 在 `/tmp` 缓存被清后会重新拉取而不是永久失败，所以用户页改写为「版本不固定 + 启动时依赖 registry」。
  生产 hub 不走这条路，`hub-daemon.sh` 跑 `~/.commhub/runtime` 下的固化安装。
- `anet hub start` 在子进程退出时 `process.exit(code || 0)`，信号杀死时 code 为 null → 退出码 0；
  所以用户页 systemd 示例用 `Restart=always`。该 unit 示例为 2026-09-25 新写，**未实跑验证**。

## 8. 维护约束（改这两页前先看）

- 显式锚点被站内其它页引用，不能改名：`/deploy/daemon#try-anet-daemon`、`#keep-daemon-alive`、
  `#anet-bin-pin`、`#hub-prereqs`、`#which-versions`（中英同名）。
- `docs-site/docs/deploy/daemon.md` 与英文版含 `2.3.0-preview.N` 形状的行，`check-release-channel-assertions.py`
  会把它们算作信道断言，`docs/RELEASE-SOP.md` 里必须保留两条登记行。页里写的都是「≥」下界，发新版不会变假。
- `keep-alive.md` 目前不含任何 `x.y.z` 版本号，因此不需要登记；以后加版本号就要同时加登记行。
- `check-docs-site-drift.py` 的注释提到 daemon.md 曾因「加了又删的行」永久 MISS；新页 `/deploy/keep-alive`
  在部署到 anet.sh 前会被该门报 404 MISS，属预期。
