# `@sleep2agi/commhub-server@0.9.0-preview.58`

## 为什么发这一版:节点取件按 token 绑定的节点解析(#1994)

`.57` 之后 `server/src` 一个功能提交:

| 提交 | PR | 内容 |
|---|---|---|
| 34cf6289 | #1994 | 节点的取件/回执路径(`get_config_update` / `ack_config_update` / `get_rules_file_request` / `ack_rules_file_request`,含技能操作)以及按别名入队,改为按调用者 token 绑定的节点解析;不再按别名取 `nodes` 表第一行 |

现场依据:同一网络里一个别名在 `nodes` 表有两行(旧行先建、在役行后建)。规则文件读取请求按在役节点入队,节点用绑定该节点的 token 来取,hub 却按别名解析到旧行,返回 `request:null`,节点只记一行 `doorbell received`,请求 60 s 超时。生产上有 23 组「别名+网络」存在多行,它们都会中。

- 绑定 token:只解析到它绑定的那个节点;该节点行不存在时不回退到同名别的行。
- 未绑定旧 token / 仅 session 的目标:仍按别名,多行时优先 `sessions` 行指向的节点,其次最新行。
- 安全负例:绑定 A 的 token 取不到 B 的请求。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.58
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.58
# 生产 hub 走 deploy/hub/README.md 的六步(改 launcher 的 RUNTIME_DIR 那一行,pm2 restart),不要整文件覆盖
```

节点侧无需任何改动(agent-network / agent-node 版本不变)。

## 证据

- 新增 10 条:origin/main 上 6 红 2 绿(2 条安全负例本来就绿),分支上 10/10;4 种变异各自变红。hub 全量 110 个文件 1304 pass / 0 fail;doc 门 rc=0。

## promote 时的 must_contain

`"version": "0.9.0-preview.58"`
