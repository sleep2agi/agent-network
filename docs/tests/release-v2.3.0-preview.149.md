# agent-network 2.3.0-preview.149

配对版本：`PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.149`，`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.116`（见 [`release-v2.5.0-preview.116.md`](./release-v2.5.0-preview.116.md)）。

自 `.148`（发版合并 `d49128cb`，#2431）以来，`agent-network/` 有 1 个改动（`git log d49128cb..origin/main -- agent-network/`）：

| 提交 | PR | 内容 |
|---|---|---|
| 4c65dd37 | #2432 | #630：`anet node start\|stop\|restart --external-appserver`，一条命令启停「固定 app-server 地址」的 codex 节点 |

## 你会看到的变化

- **固定 app-server 地址的 codex 节点可以用 anet 启停了（#2432）。** 以前 `config.json` 里写了固定 `codexAppServerUrl`、以三个 tmux 会话运行的 codex 节点只能靠手写脚本拉起。现在：
  - `anet node start <名字> --external-appserver` 依次启动 `<名字>-appsrv`（`codex app-server --listen <url>`）→ 等 `/readyz` 返回 200（最多 30 秒，超时则什么都不再启动并清掉 app-server 会话）→ `<名字>-tui`（仅当 `codexCopresence` 和 `codexThreadId` 都设置时，`resume <codexThreadId> --remote <url>`）→ `<名字>`（与本 anet 配对的 agent-node 桥，日志写到 `logs/tmux-bridge.log`）。
  - 节点令牌在会话**内部**从 `config.json` 读取，不出现在 argv 或面板启动命令里。
  - 第一次带 `--external-appserver` 会在 `config.json` 写入 `codexLaunchLayout: "external-appserver"`（原地改一个键、保留文件权限），之后直接 `anet node start|stop|restart <名字>` 即可。没有这个记录的节点（包括 `--copresence` 建的原生共存节点）走原来的路径，不受影响。
  - 拒绝启动的情况：三个会话中任一已存在（整串比较，中文名安全）、端口被占、`MemAvailable` 低于 4 GiB（`--force` 只放开内存检查）。
  - `anet node restart <名字> --bridge-only` 只重启桥（升级路径），app-server 和 TUI 进程不变。
  - 启动后检查桥日志里有 `resumed thread <codexThreadId>`：接到别的线程或新建线程退出码 3，`--verify-timeout`（默认 60 秒）内没出现退出码 4；两种情况都不会停掉会话。
- 配对的 agent-node 升到 `.116`：节点读取自己的 `secrets.env`（必须 `0600`），daemon 建节点时写到这个文件，详见 agent-node 说明。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.149 @sleep2agi/agent-node@2.5.0-preview.116
```

## Upgrade

```bash
anet upgrade --channel preview
# 或显式指定：
npm i -g @sleep2agi/agent-network@2.3.0-preview.149 @sleep2agi/agent-node@2.5.0-preview.116
```

两个包一起升级（`agent-network@2.3.0-preview.149 ↔ agent-node@2.5.0-preview.116`）。🔴 agent-node `.116` 会拒绝权限不是 `0600` 的 `secrets.env`，升级前先检查。

## 证据

- #2432：`codex-external-appserver.test.ts` + `cli-args.test.ts`；Docker 套件 `tests/test-codex-external-appserver`（假 `codex` + 假配对 agent-node，私有 `ANET_TMUX_SOCKET`，无 Hub、不碰宿主状态）覆盖启动顺序、拒绝条件、`--bridge-only`、线程校验退出码、停止顺序与诱饵会话存活、令牌不出现在任何 `/proc/*/cmdline`，并带套件内变异对照。
- 未在真实生产节点上验证。

## promote 时的 must_contain

`"version": "2.3.0-preview.149"`
