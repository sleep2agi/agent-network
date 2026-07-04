# Agent Network v2.3.0 — Release Notes

> **状态**：草稿，pre-GA gate 已绿（4 包整行 e2e 23/23）。**等 Vincent 拍 latest 后正式发布**。
> 详细进度：[tracking issue #403](https://github.com/sleep2agi/agent-network/issues/403) · 计划：[plan.md](./plan.md)

## 主题
**数字 AI 员工军团的指挥中心**——把「建节点 / 选服务器 / 配模型与密钥 / 管通道」从命令行搬进 Dashboard，一处指挥整支 agent 团队。

## 版本（4 包一起切）
| 包 | v2.3.0 GA | 上一 GA |
|---|---|---|
| `@sleep2agi/agent-network` | 2.3.0 | 2.2.21 |
| `@sleep2agi/agent-node` | 2.5.0 | 2.4.13 |
| `@sleep2agi/commhub-server` | 0.9.0 | 0.8.8 |
| `@sleep2agi/agent-network-dashboard` | 0.7.0 | 0.6.0 |

## 亮点

### 🖥️ Dashboard 成了指挥中心
- **模型供应商预配置库（#393 / RFC-028）**：provider 增删改、per-server 可达性矩阵、**API key 写入即进 hub vault、只回 `hasKey` 从不回显**。建节点时从库里选 preset。入口在**左侧栏 Providers**。
- **单节点设置面板（#260）**：模型 select + 运行模式 flags + **一键重启**（optimistic→applying→applied 状态机），真接 `/api/anet/node-config`。
- **Channel 编辑（#260 全链路）**：Dashboard 勾选启用/停用节点通道（telegram / feishu），走 hub `update_node_config` channels schema → restart-tier → 节点重启重载通道 worker。per-channel 密钥仍只读 masked（不上 UI）。hostile 输入（未知通道 / 注入串）在 hub 侧 narrow 白名单 drop。

### 🛰️ 多守护节点（RFC-026 P2）
- hub 聚合所有在线 host_supervisor daemon（`list_host_supervisors` + REST 镜像）。
- 建节点路由到**选中的那台服务器**（`create_node` + `daemon_node_id`），含 admin gate + 双层校验 + 背压 + audit。
- Dashboard「选服务器」picker（0 / 1 / 多 三态）。跨 daemon 越权拒（`not_your_request`）。

### 🩹 节点管理 P0 修复
- **#180**：rename 运行中节点后不再残留 ghost 进程（env-sweep 修 + 永久 CI 回归门）。
- **#203**：连开多节点 alias 不再错乱。
- stop / delete 契约稳（RFC-027）。

### 🧩 opencode 第 5 runtime（ride-along，未主打）
- ACP 内核活体已跑通 **free model**（真 ACP session + 真流式 + 真计费 token + 子进程真收）。真 vendor（Anthropic/OpenAI）活体 + 正式主打**留到后续**。

## 升级 / 部署注意
- **Channel 编辑走 restart-tier**：应用通道变更会触发节点 `exit(75)` 重启，**需要外部 supervisor 拉回进程**（`anet node start` / host_supervisor daemon / systemd `Restart=always` / docker `restart:always`）。手动 spawn（裸 `nohup`）的节点没 supervisor 不会自动重启。详见 [troubleshooting/remote-node-cli-login](../../docs-site/docs/troubleshooting/remote-node-cli-login.md) 与 RFC-024 §6.7.1。
- **多机 auth**：跨机建节点优先走 **API key 路线**（key 跟 config/vault 走）；claude-code-cli 订阅登录态机器绑定不可移植，远程 host 需各自 `claude login`。

## 验证
- 4 包整行 pre-GA e2e：**23/23 PASS**（`docs/tests/p-v230-pregame-4pkg/`）。
- 节点管理回归：15/16（1 为容器缺 codex CLI 的 harness 限制）。
- multi-daemon Scenario H：59/0（`docs/tests/p-rfc026-p2-scenario-h/`）。
- 各包单测：agent-node 712/0、commhub 504（8 沙箱 env）、classify 26/0。

## 已知延后
- opencode 真 vendor 活体 + 主打（等 key）。
- per-channel 密钥的 UI 编辑（当前只读 masked）。
- config_snapshot 在 P1 重活下被刷空（bounce workaround，单独修）。
