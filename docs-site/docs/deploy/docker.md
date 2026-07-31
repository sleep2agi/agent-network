# Docker 部署

::: warning 完整 Docker 部署指南待写
本页原本基于 `demos/codex-telegram-squad/` 目录的 Dockerfile + docker-compose 写成，但该 demo 已在 [#198](https://github.com/sleep2agi/agent-network/issues/198) docs 重写中移除，老路径已 stale。**完整 Docker 部署指南**（hub + dashboard + 多 agent 一键 compose）排进 v0.11+ doc rework。

在那之前，下面是「跑得通」的最小路径。
:::

## 推荐路径：npm + tmux（最稳）

绝大多数自部署用户实际跑的是 **npm 全局装 + tmux + `anet project up`** 组合 —— 比 docker compose 更轻、debug 更直、迭代更快。详见：

- [干净服务器从零部署](/deploy/clean-server) — 空 Ubuntu/Debian 上起 hub + dashboard + 多个 agent 的分步流程（`setup-anet.sh` 一键脚本[已退役](/guide/one-shot-install)，不要运行旧副本）
- [npm 部署指南](/deploy/npm) — 手动版本的 step-by-step
- [生产部署 / 公网部署安全](/deploy/production) — TLS / 防火墙 / 备份 / 公网风险点

`@sleep2agi/agent-network` 的所有 CLI 命令（`anet hub start` / `anet hub dashboard` / `anet node create/start` / `anet project up/restart/down`）在裸 Docker 容器里和裸 host 上行为一致 —— 把容器当成「带 Node.js + Bun 的 Ubuntu」即可。

## 想自己写 Dockerfile？

仓库里有几份**测试用** Dockerfile 可以当起点抄：

- [`tests/Dockerfile`](https://github.com/sleep2agi/agent-network/blob/main/tests/Dockerfile) — Node.js + Bun 基础镜像 + 装 anet 的最小集
- [`tests/qa-hub-13-server-health-agents/Dockerfile`](https://github.com/sleep2agi/agent-network/blob/main/tests/qa-hub-13-server-health-agents/Dockerfile) — hub + 多 agent 的可跑参考

这些是 release-gate 测试用，**不是为生产部署优化**（没做 multi-stage / 没固定 hash / 没做 non-root 用户）。生产上请自行加 hardening。

## 启动顺序建议

不管 docker compose 还是裸 tmux，一台机器上的启动顺序固定：

1. `anet hub start --host 0.0.0.0`（绑 LAN；本机用 default `127.0.0.1` 也行）
2. `anet hub dashboard`
3. `anet login --username admin --password <你的密码>`（首次 hub start 会自动 bootstrap `admin`/`anethub`，**公网部署前立刻 `anet passwd` 改强密码**）
4. `anet node create <alias>` × N（每个 agent 一份配置）
5. `anet project up` 把 cwd 下所有节点起起来

容器化版本基本是把第 1-5 步分到不同 service / container。

## 常见坑

- **`bunx` 拉 `commhub-server` 慢**：第一次 `anet hub start` 会从 npm registry 拉一个 PINNED 版本 `commhub-server` —— 容器内首次启动可能比 host 慢 30-60s（cache 在 `$HOME/.bun/install/cache`）。固定基础镜像 + 预热 cache 可显著提速
- **Dashboard 容器要能反向调 Hub**：Dashboard 走 REST + SSE 调 hub `:9200` —— 容器间通信要在同一 docker network，或者把 hub 端口 publish 到 host
- **节点 cwd 持久化**：`anet node start` 把状态写到 cwd 下 `.anet/nodes/<alias>/`，容器重启要保留这份就得把 cwd 挂出来当 volume
- **agent 进程不要 PID 1**：用 `tini` 之类的 init 包一层，否则 SIGTERM 直接送到 agent 进程会跳过 CommHub 的 offline 通知

## 下一步

- [npm 部署指南](/deploy/npm) — 不走 Docker 的标准 step-by-step
- [生产部署 / 公网部署安全](/deploy/production) — TLS / 防火墙 / 备份 / 安全注意
- [一键安装脚本已退役](/guide/one-shot-install) — 旧 `setup-anet.sh` 已停用，页内说明替代路径
