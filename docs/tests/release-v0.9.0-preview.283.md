# commhub-server 0.9.0-preview.283

Since `.282`（把 .282 之后合入 main 的三笔 Hub 侧改动发出去）

## Why

生产 Hub 跑的是 `.282`。之后 main 上合了三笔 Hub 侧改动，其中「节点职责介绍」是 admin 2026-11-15 提的需求：
每个节点的职责要让其他节点也能看到（AGENTS.md 是节点给自己看的，description 是给别人看的名片）。

## What changed

```text
#3598  feat(hub)  节点职责介绍 nodes.description
                  —— PUT /api/nodes/:id/attrs 可写 description（多行，≤ 1000 码点，attrs_revision 乐观锁）；
                     节点令牌只许写自己的（description_self_only），人按网络写权限；
                     GET /api/nodes 每行带 description；
                     MCP get_all_status 写了的节点行带一行摘要（≤ 120 字）；get_session_status 新增 profile
#3591  fix(hub)   report_status 的 config_snapshot 缺 node_id 时局部拒绝，并在回执里标注（#3585）
#3575  feat(hub)  create_node 可指定新节点的部门，首次注册时写入（只填空）
```

## Verified

```text
· #3598：node-description.test.ts 6 pass、node-description-http.test.ts 4 pass（另一个节点的令牌经 MCP 读到；
  自己写 200、写别人 403）、node-attrs.test.ts 13 pass、agent-acl-slice3-http 38 pass、tool-audience-http 13 pass（字节上限未抬）
· #3591 / #3575 各自 PR 的 CI 绿后合并；本版不额外改代码，只发既有 main
· release.yml 四道门（install smoke / PINNED 审计 / 发布说明形状 / 文档版本断言）会再检一遍
```

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.283
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.283
# production: 用 scripts/deploy-hub-runtime.sh --version 0.9.0-preview.283
#   （它做 装 → 验 → 切 → 回读 → 失败即回滚，并按 docs/runbooks/hub-release-deploy.md 写 build-info.json）
#   注意：anet 主机的 ~/.local/bin/hub-daemon.sh 硬编码了 HUB_RUNTIME_DIR，要改那一行再 pm2 restart。
```

## What it does not do

```text
· 不含节点侧改动：agent-node / channel 的内置 MCP 工具表没变，节点不升级也能在 get_all_status 结果里读到 description；
  「节点用 MCP 工具写自己的职责介绍」和 channel 暴露 get_session_status 留作后续
· 不改 node-permissions 开关的语义（节点令牌写别的节点 display_name / team / tags 仍按开关；只有 description 硬拦）
```
