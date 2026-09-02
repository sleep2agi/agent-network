# 2026-09-02 app#225 从开发到上线的全链路记录（含生产 hub .38 → .45）

> 目的：下一个人要把一条「hub + agent-node + 桌面端」三端联动的能力送到用户手里时，
> 照这份走，别再踩今天踩过的七个坑。每个数都是当天量的，时间为 CST。

## 结果

| 产物 | 之前 | 之后 | 凭证 |
|---|---|---|---|
| `@sleep2agi/agent-node` latest | 2.5.0-preview.34 | **2.5.0-preview.58** | release-gate run 33584699037 → promote run 33596008789 |
| `@sleep2agi/agent-network` latest | 2.3.0-preview.47 | **2.3.0-preview.76** | release-gate run 33595863100 → promote run 33598173766 |
| `@sleep2agi/commhub-server` preview | 0.9.0-preview.44 | **0.9.0-preview.45** | release-gate run 33586157333（latest 仍 .30，未动） |
| 生产 hub（DEV pm2 `commhub-hub`） | **preview38**（仓里写 44，错） | **preview45** | `~/.local/bin/hub-daemon.sh` 记录行 + `commhub.db.bak-prehubupgrade45-*` |
| 桌面端 | desktop-v0.2.41（v0.2.42 draft） | **desktop-v0.2.43 已发布** | app run 33595866989；`anet.sh/desktop/update/latest.json` 返回 0.2.43 |
| anet.sh | 下载按钮指 0.2.41 | 指 0.2.43；MCP 工具页 +5 | #1762；drift 门 rc=0 |

主仓 PR：#1755（hub 5 工具 + agent-node 门铃）/ #1757（agent-node .58）/ #1758（说明补 Install/Upgrade）/
#1759（server .45）/ #1760（PIN .45）/ #1761（CLAUDE.md）/ #1762（首页链接）/ #1763（#1756）/ #1764（#1749）。
app 仓：#227（功能）/ #228（v0.2.43 说明）。

## 顺序（硬约束，量过）

1. 主仓功能 PR 合 main → 2. bump PR（package.json / package-lock ×2 / 配对常量）+ `docs/tests/release-v<ver>.md`
（**必须有 `## Install` / `## Upgrade` 且 Install 段含 `@<ver>`**）→ 3. `release-gate (v0)` dispatch
`package= version= publish=true` → 4. **≥30 分钟后**才能 `promote-latest`（闸自己算发布时间）→
5. `PINNED_SERVER_VERSION` 只能在 server 新版**出现在 npm 之后**再改（gate 2 拿它核对已发布）→
6. 生产 hub 照 `deploy/hub/README.md` 六步 → 7. 桌面端 `release-desktop-auto-update`（`commit` 40 位）→
**`macos-signing` 环境审批**（reviewer 是 owner 账号）→ 产物是 draft → Publish → 8. anet.sh 首页链接 + 重新部署。

## 今天的七个红，每个都是「我量的命令 ≠ 门跑的命令」或「照抄少抄了一半」

| # | 红 | 真因 | 修 |
|---|---|---|---|
| 1 | L0 `rules-file` 匹配 0 个文件 | `qa.sh` L0 写死 `cd server`，agent-node 路径被当过滤器 | L0 按路径首段进包目录（`qa.sh`） |
| 2 | doc-symbol-pins | db.ts 插 31 行把 `logAudit` 挤到 L1696；本地跑门**没带 CI 的 `. --doc-root docs-site`** 假绿 | 改 pin；纪律 ⑧ |
| 3 | test629 | 工具清单要按源码顺序补 5 个 | probe.ts |
| 4 | bun-install-pin | 新 Dockerfile 用了 `curl bun.sh/install \| bash` | 照 test679 钉版本 + sha256 |
| 5 | release-gate 闸 3 | `.58` 说明只抄了 `.57` 的上半，缺 Install/Upgrade | 补段 |
| 6 | promote 闸 4「不在字节里」 | `must_contain=[rules-file] doorbell received`，闸的 grep **无 `-F`**，`[…]` 成字符集 | 换 `get_rules_file_request`（用闸原样命令两向验） |
| 7 | hub-launcher-pin | 改了 `PINNED_SERVER_VERSION` 没跟 `deploy/hub/hub-daemon.sh` 的 `RUNTIME_DIR` | 改 + 记录行 |

另两条不是红但值得记：promote 闸「不足 30 分钟」是设计；desktop job `waiting` 是环境审批不是排队。

## 生产 hub .38 → .45（13:50–13:52）

- 事前：`/health` 272 sessions / 129 SSE；近 5 分钟心跳会话 130、task_events 27。
- 备份 `VACUUM INTO`（396 MB，integrity ok，sessions 272 / tasks 46895）；`user_inbox` 表在 .38 上**不存在**（.41 才建），
  所以 #1493 的 NOT NULL 迁移不涉及。
- sibling 安装 `~/.commhub/runtime-v41-preview45`；旁路 9291 + DB 副本 boot：version .45、sessions 272、vault ok、
  `node_rules_requests` 已建；验完按精确 PID 停（**`pgrep -f` 会匹到当前 shell 自己**，用 `ps -C bun` / `ss -ltnp`）。
- 只改机器副本的 `RUNTIME_DIR` 一行 + 记录行（机器副本比 Git 多一行 `COMMHUB_ENABLE_SIDE_THREADS`，**别整文件覆盖**）；
  `pm2 restart commhub-hub`（无 `--update-env`）。
- 事后 25 s：SSE 129（=基线）；心跳会话 130（=基线）；vault 报错 0；migrate 警告 0；unstable 0；祖先链是 PM2 God Daemon。
- 回滚目标 `runtime-v40-preview38`，旧目录未删。

## 边界（量到的，不是猜的）

- 规则文件 / 生命周期工具都按 `node_id` 定位；节点 config 无 `node_id` ⇒ hub 无 `nodes` 行 ⇒ 桌面端不显示该区块。
  当天舰队 272 会话中 205 有 node_id（TM 76 中 54）。
- TM 团队的节点：只读监控，不操作（Vincent 16:3x 定）。
