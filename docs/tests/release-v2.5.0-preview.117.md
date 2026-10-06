# agent-node 2.5.0-preview.117

自 `.116`（发版合并 `a0ee5b93`，#2435）以来，`agent-node/` 有 1 个改动（`git log a0ee5b93..<发版提交> -- agent-node/`）：

| 提交 | PR | 内容 |
|---|---|---|
| 5961a433 | #2439 | #648：daemon 节点 `config.json` 新增 `daemonExtraPath`；建节点时 runtime 的 CLI 判为 `missing_cli` 就在 spawn 之前拒绝 |

（同期合入、不在本包里的：#2438 只改官网下载页。）

## 🔴 升级须知

- 🔴 **升级前先配 `daemonExtraPath`。** 如果这台机器上的 `codex` / `grok` / `claude` 不在运行 daemon 的 node 同一目录，也不在系统目录，要先把这些命令所在目录的绝对路径写进该 daemon 节点 `config.json` 的 `daemonExtraPath`（字符串数组），然后重启 daemon。否则从 app 建这几种节点会被直接拒绝，不会先 spawn 再失败。报错里会写缺哪个命令，以及去哪里配。
- 🔴 （沿用 `.116`）节点只读权限为 `0600` 的 `<节点目录>/secrets.env`：是符号链接、属主不是当前用户或权限不是 `0600` 时节点拒绝启动。升级前检查已有的 `secrets.env`，修法：`chmod 600 <节点目录>/secrets.env`。

## 你会看到的变化

- **daemon 子节点的 PATH 可以追加目录（#2439，#648）。** 子节点 PATH 仍是固定前缀（node 所在目录 + 系统目录），**不继承 daemon 自己的 PATH，也不猜 `~/.local/bin` / nvm**。额外目录只来自 daemon 节点 `config.json` 的 `daemonExtraPath`（字符串数组）：
  - 只收绝对路径；相对路径、`~`、带路径分隔符的条目丢掉；与固定 PATH 去重，追加在固定 PATH **之后**。
  - 就绪探测和真正 spawn 用同一份 PATH。
  - 手改 `config.json` 后要重启 daemon 才生效。
- **缺 CLI 时建节点在 spawn 前拒绝（#2439，#648）。** 建节点时该 runtime 的 CLI 判为 `missing_cli`（找不到，或 `--version` 失败）就在写 config 和 spawn **之前**拒绝，报错写明缺哪个命令、去 daemon 节点 `config.json` 的 `daemonExtraPath` 配绝对路径后重启 daemon。`--version` 超时仍是 `unknown`，不在这里拒。

## 与 Hub 的配合

- 不需要升级 Hub。#2439 不改 `server/`。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.117
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.150 @sleep2agi/agent-node@2.5.0-preview.117
```

升级后 daemon 要重启（`anet daemon restart <名字>`）才会用新的 PATH 规则。
- 🔴 **两个包一起升级**（`agent-network@2.3.0-preview.150 ↔ agent-node@2.5.0-preview.117`）。
- 发布顺序：先 agent-node `.117`，再 agent-network `.150`，两者来自同一个合并提交。

## 证据

- #2439：Docker `oven/bun:1.3.14`，codex 只放在 `/opt/x/bin`：不配置时就绪 `missing_cli`、建节点被拒、无 spawn、无子节点 config（3 pass / 0 fail）；配上 `daemonExtraPath` 后就绪 `ready`、建节点 ack `started`、spawn 环境能跑到这个 codex。回归 `runtime-readiness.test.ts` + `create-node-daemon.test.ts` 108 pass / 0 fail。变异（`appendExtraPath` 直接返回原 PATH）2 fail。Docker 套件 timeout PASS=17 FAIL=0、共存 PASS=26 FAIL=0。
- 未在真实生产节点 / daemon 上验证。

## promote 时的 must_contain

`"version": "2.5.0-preview.117"`
