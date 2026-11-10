# @sleep2agi/agent-node 2.5.0-preview.179

Since `.178`: 在打开共存运行时**之前**，把对账判据的三格输入无条打印出来。
不是功能变更，是为了把一个「壳里 true、进程里 false」的矛盾变成一行真值。

## Why

`.178` 的 `armModelReconcile` 已生效（生产日志确认 marker 被清空），
但**下一次启动并没有按配置对账**：

```text
[13:54:41] armed reconcile-on-next-start (marker cleared)   ← 发现漂移，成立
config.json: marker = ''
[13:55:48] keeping the resumed session's selected model      ← 却没修
```

而在壳里用**同一份函数、同一个文件**跑：`shouldReconcile(cfg, 'xai/grok-4.7') = true`。

⇒ 进程里那份 `fileConfig` 与磁盘不是同一份，或 `OPENCODE_GENERATION` 在 bridge 模式下另有取值。
在这条真值打印出来之前，任何「自愈已修好」的结论都是猜的。

## What changed

`cli.ts` 在 `openOpenCodeCopresenceRuntime` 之前新增一行 warn：

```text
[opencode] reconcile inputs model="…" marker="…" generation="…" resume="…" decide=true|false
```

同时把 `reconcileResumedModel` 改为复用同一个 `reconcileDecision` 变量
（原来表达式写了两遍，打印值与实际用值可能不是同一次计算 —— 那正是最难查的一种）。

## Verification

```text
本版只加诊断，不改判定逻辑；判定逻辑由现有单测覆盖（profile-state.test.ts 10 pass）。
生效判据：节点重启后日志里出现 reconcile inputs 一行，且 decide 与随后行为一致
（decide=true 必须看到 session model 被改到配置值，或明确的失败信息）。
```

## What it does not do

- 不修复对账；只让「为什么判成 false」这个问题的答案出现在日志里。
- 不改变 `.178` 的行为。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.179
```

## Upgrade

```bash
anet node restart <name>
```
