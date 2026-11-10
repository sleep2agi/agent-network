# commhub-server 0.9.0-preview.281

Since `.280`（本版是把 main 上已合并、但一直没发布的改动一次性发出去）

## Why

main 的 `server/package.json` 早在 `.281` 就已经 bump 了，但**这个版本从未发布到 npm**
（`npm view @sleep2agi/commhub-server@0.9.0-preview.281` → 404），而生产 Hub 却在跑一次本地构建的 `.281`。
结果是「合并了」与「上线了」之间没有可查的桥：想确认某个修复是否在生产里，只能去产物里 grep。

本版把 `.281` 正式发布，让版本号重新可对账。

## What changed

```text
#4467  fix(hub)    目录接口把「凭据类型不对」和「body 不合法」分开（403 / 400）
                   —— 之前两者共用 400，排障时会把「不该用节点令牌」读成「body 拼错了」
#3488  feat(adopt) 用节点自己的令牌证明同一个 Hub，而不是比对 URL 文本
#3485  feat(fork)  fork 出来的子节点继承源节点的部门
#3464  feat(hub)   每节点收件白名单（接收侧权限）+ anet node perm
#3463  fix(server) tool-list 字节数回到预算内（精简措辞）；server 单测夹具从 /work 与 /tmp 迁出
#3429  fix(hub)    /api/nodes 列表补上 opencode_agent_config_capable
f6d9e8c2f         节点自报它的 anet CLI 版本（launched_by_cli_version）
```

## Verified

```text
· 我的改动（#4467）：session-source-directory-http.test.ts 17/17；
  本地全量 server 套件在 CI 的 test798 镜像里绿（宿主上因缺 /work 会有环境性红，见 local-iteration runbook）
· 其余条目各自 PR 的 CI 均绿后合并；本版不额外改动代码，只发既有 main
· release.yml 的四道门（含发布说明必须带 Install 与 Upgrade）会再检一遍
```

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.281
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.281
# production: 安装到 ~/.commhub/runtime-0-9-0-preview-281，把 hub-daemon.sh 指向它，pm2 restart commhub-hub
# 🔴 部署时按 docs/runbooks/hub-release-deploy.md 写 build-info.json（本版正是为了不再出现“生产版本不可回溯”）
```

## What it does not do

- 不改任何权限模型：目录接口的 403 只是把「凭据类型不对」与「请求体不合法」分开，判定逻辑不变。
- 不激活 preview 车道：`选已有项目/会话` 与 `Fork` 仍要求 daemon 上报 `daemon_capabilities`
  （见 docs/runbooks/source-preview-enablement.md）。
- 不改变 `light=1` 窄投影：能力旗仍只在 `?alias=` 的完整投影里。
