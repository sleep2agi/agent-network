# commhub-server 0.9.0-preview.282

Since `.281`（把生产 runtime `7ec4770c` 之后合入的 Hub 侧修复发出去）

## Why

生产 Hub 跑的是 `.281`（本地构建的 `7ec4770c`）。之后 main 上又合了两笔 Hub 侧修复，
但没有任何版本把它们带上线 —— 又是「合并了」与「上线了」之间的那段空白。本版把这两笔正式发出。

## What changed

```text
#3564  fix(hub)  广播的 from_session 用真实调用者，不再写死 'hub'
                  —— 之前 type=broadcast 的 from_session 恒为 'hub'，收件人看到「来自 hub」，
                     正文却是 "[某节点] …"。生产实测 3234 行受影响（#4066）
#3570  fix(hub)  never_consume 闸的内存计数以最后一次回复为界
                  —— 已经把任务回过、账本还留着的，不再算作「未消费」
```

## Verified

```text
· #3564 自带 broadcast-attribution.test.ts（1 pass / 7 expect）；扇出语义测试 8 pass 未破
· #3570 各自 PR 的 CI 绿后合并；本版不额外改代码，只发既有 main
· release.yml 四道门（install smoke / PINNED 审计 / 发布说明形状 / 文档版本断言）会再检一遍
```

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.282
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.282
# production: 用 scripts/deploy-hub-runtime.sh --version 0.9.0-preview.282
#   （它做 装 → 验 → 切 → 回读 → 失败即回滚，并按 docs/runbooks/hub-release-deploy.md 写 build-info.json）
```

## What it does not do

```text
· 不含节点侧改动（迟到回复终态 #3571 / interrupt 并发 #3558 走 agent-node .208 那条线）
· 不改权限模型与 board 判定（#3545 已在 .281 的运行时里）
