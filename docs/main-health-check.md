# main 健康检查（合并流程三步）

> 2026-11-22 定。起因：同一天出现三次「合并时漏测、main 悄悄带病」——
> `PromptTracker.clear(reason)` 的 TS2554、`/api/nodes/:id/opencode-sessions` 重复注册、
> `variant-persist` 的裸 `renameSync`。三次都不是单个 PR 的错，而是**没人看 main 自己的 CI**。

## 为什么需要这一页

单个 PR 的 CI 绿 ≠ main 绿：

```text
· 两个 PR 各自绿，合到一起才冲突（重复路由）
· 一个 PR 的测试只覆盖自己那条路径，另一次合并把它的前置条件改掉
· 某些门只跑 main push（例如依赖全量矩阵），PR 上根本看不到
```

代价很实在：main 一红，所有碰同一包的 PR 都被卡住，而且要靠下一个人「碰巧」发现。

## 三步（都很便宜）

### ① 合并前：先看 main 最新一次 CI

```text
打开 Actions → 选中要跑的 workflow → 看 main 分支最新一次 run 的结论。
红着就先修 main，不要把自己的 PR 叠上去。
```

判据：**要合的那个包**对应的必过项（lint / typecheck / unit）在 main 最新一次 run 上是绿的。
不要只看自己 PR 的 check-runs —— 它们不告诉你 main 现在是不是好的。

### ② 合并后 5 分钟内：跑一遍三个必过项

```text
lint (required) / agent-node-typecheck / server unit (Docker, non-root)
```

只跑这三个，不等全量矩阵（全量在后面自己会跑；这三个是最容易「看漏」的地方）。
红了立刻回到 ③，别等下一个 PR 撞上来才发现。

### ③ 谁合并谁负责把 main 拉回绿

```text
· 30 分钟内没处理 ⇒ 在群里点一次名（不是催进度，是让其他人知道这块暂时别动）
· 拉绿之前，别人只 rebase、不抢修；修的人只改导致红的那一处
· 修完在 PR 里贴：红的 job 链接 + 变绿的 job 链接
```

## 合并者自检清单（复制即用）

```text
[ ] main 最新一次 CI：要合的包对应的必过项是绿的
[ ] 我的 PR 自己绿，且没有靠 skip 换绿
[ ] 合并方式与标题取自 PR 本身（不手抄、不改数字）
[ ] 合并后 5 分钟内看过三个必过项
[ ] 红了：已回 ③，并在 30 分钟内处理或点名
```

## 适用范围

```text
· agent-network（Hub / agent-node / CLI）与 agent-network-app（客户端）都适用
· 「必过项」按仓库当前配置调整；本页只规定「必须去看」与「谁负责」，
  具体名单以各仓分支保护设置为准
```
