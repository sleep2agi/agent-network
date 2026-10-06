# agent-node 2.5.0-preview.115

自 `.114`（发版合并 `b87cb86f`，#2425）以来，`agent-node/` 有 1 个改动（`git log b87cb86f..origin/main -- agent-node/`）：

| 提交 | PR | 内容 |
|---|---|---|
| 183bc272 | #2429 | #622：daemon 逐个 runtime 自检「这台机器上能不能真的建出这种节点」，上报 `runtime_readiness` |

（同期合入、不在本包里的：#2426、#2428 只改 agent-network / 部署脚本，见 anet `.148` 说明；#2430 只改官网下载页。）

## 你会看到的变化

- **daemon 会告诉你每种 runtime 在这台机器上能不能用（#2429）。** 以前 App 里的「可建节点 ✓」只说明 daemon 的 anet 版本对得上，不代表 claude / codex / grok / opencode 在这台机器上真的能跑——建出来才发现 CLI 找不到、没登录或连不上服务商。现在 daemon 在启动时和之后每 10 分钟（±10% 抖动）在后台对 `runtimes_supported` 里的每个 runtime 检查一次：
  - **CLI**：在 daemon 给子节点的 PATH（不是 daemon 自己的 PATH）上能不能找到，`--version` 报什么；
  - **登录**：只看登录文件 / API key 变量名在不在，**从不读取、从不上报内容或值**；
  - **网络**：对服务商发一次 HEAD（5 秒超时，遵守 `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`）；
  - **codex 共用登录**：本机有几个别的节点和新节点共用同一份 codex 登录（只上报一个数字）。
  - 结果放在心跳的 `config_snapshot.daemon_capabilities.runtime_readiness` 里，每项是 `ready` / `missing_cli` / `not_logged_in` / `no_network` / `unknown` 之一，附中文原因和修法。结果变化时立即补报一次心跳，不等 3 分钟。
  - 自检全部在后台进行，心跳只读缓存，不会拖慢心跳；单步 5 秒、单个 runtime 20 秒超时，超时报 `unknown`，不猜。
  - `can_create_nodes` 的含义**不变**，旧版 App 不受影响。
  - 已知限制：daemon 给子节点的环境里没有代理变量，所以需要代理的机器上可能显示「网络可达」（daemon 自己走了代理），而子节点实际连不上。

## 与 Hub 的配合

- 要在 `GET /api/host-supervisors` 里看到 `runtime_readiness`，需要 Hub `0.9.0-preview.107`（#2429 的 Hub 侧）。
- 在当前 Hub `0.9.0-preview.106` 上：`daemon_capabilities` 不是严格模式，新字段会被 Hub 丢弃，心跳其余内容和派活照常，不会被拒。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.115
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.148 @sleep2agi/agent-node@2.5.0-preview.115
```

升级后要重启 daemon（`anet daemon restart <名字>`）才会开始自检。
- 🔴 **两个包一起升级**（`agent-network@2.3.0-preview.148 ↔ agent-node@2.5.0-preview.115`）。
- 发布顺序：先 agent-node `.115`，再 agent-network `.148`，两者来自同一个合并提交。

## 证据

- #2429：`runtime-readiness.test.ts` 25 个用例（就绪 / 缺 CLI / CLI 坏 / 未登录 / 无网络 / 超时、子进程 PATH 与 daemon PATH 区分、埋入的假密钥不出现在输出里、真 CONNECT 代理）。
- 新 Docker 套件 `tests/qa-runtime-readiness`（真 Hub + `anet daemon up`，`--network none` + 容器内假代理）PASS=26 FAIL=0；埋入的密钥既不在 Hub 响应里，也不在 daemon 日志里。
- test725 agent-node 单测 2455 pass / 0 fail；变异（登录检查恒真 / 用 daemon PATH / 去掉网络检查）各自变红。
- 未在真实生产 daemon 上验证。

## promote 时的 must_contain

`"version": "2.5.0-preview.115"`
