# commhub-server 0.9.0-preview.262

Since `.261`: 修掉「父任务链接被丢弃、但 `meta.parent_source` 还留着」那一格 ——
它正是生产库里 2 条 `parent_source:"explicit"` 而 `parent_task_id` 为空记录的成因。

## Why

`send_task` 里两段代码之间没有连线：

```text
① if (parentSource && parentTaskId) { meta.parent_source = parentSource }   ← 拼 meta
② 校验显式父是否存在；不存在 ⇒ parentTaskId = null                          ← 丢父
③ INSERT（meta 用 ① 的，父用 ② 之后的值）
```

显式父不存在时（LLM 幻觉 id、与 retention 清扫赛跑），父被丢弃、派发继续 ——
这个决定是对的（一个假 id 不该挡掉整条任务）。但 meta 里仍写着「有一个 explicit 父」。

生产读数（修之前）：

```text
tasks 131684 行里 2 条
  meta = {"parent_source":"explicit"}，parent_task_id / in_reply_to / thread_id 全空
  5bc82d72  2026-10-30 16:08:38      d002b739  2026-10-31 02:23:09
```

## 这格为什么一直没被发现

`#669` 加的不变式是**单向**的：

```text
parent_task_id 有值 ⇒ 要求 parent_source 有值     ✅ 有断言
parent_task_id 为空 ⇒ 不要求                      ✅ 合理
source 有值 但父为空                               🔴 两个半条件同时放过
```

坏行既不进 `explicit` 也不进 `inferred`，所以在任何按来源分组的比率里都看不见 ——
它只表现为「分母比看起来小一点」。

## What changed

```text
「父不存在 ⇒ 丢父」那个分支里同时清来源：
    parentSource = null;
    metaJsonWithParent = metaJson;
```

行为上没有别的变化：任务照样建成、照样派出、结果照样回。

## Verification

```text
真 handler 派一条带不存在父的任务：
  修前 ⇒ meta = {"parent_source":"explicit"}（复现生产那 2 行的形状）
  修后 ⇒ 1 pass（建成 · parent_task_id 为 NULL · meta 里没有 parent_source）

回归：chain-attempt-dedup + parent-source-marker + parent-infer + 新文件 = 30 pass / 0 fail
只读复核：scripts/report-parent-source-coverage.py（三态 + 切口 2026-10-29 + --assert）
```

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.262
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.262
# hub run by pm2 (production profile) —— 本仓用部署脚本切运行时
scripts/deploy-hub-runtime.sh --version 0.9.0-preview.262
```

上线后回读（应显示 `source, no parent 2` 且不再增长；那 2 条是修之前留下的历史）：

```bash
COMMHUB_DB=~/.commhub/commhub.db python3 scripts/report-parent-source-coverage.py
```
