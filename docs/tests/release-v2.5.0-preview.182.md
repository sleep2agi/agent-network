# agent-node 2.5.0-preview.182

Since `.181`: **claude-agent-sdk 的超时口径从「总时长」改成「无进展」**（#4010）。

## 现场（这次真的有人被卡住）

```text
[伪神明] 执行出错: claude-agent-sdk 调用超时（300s × 3 attempts）
          各次 300s 超时 / 期间没有任何响应
```

一次页面优化，用户等了约 15 分钟只拿到这一句 —— 而它其实**一直在动**，只是单条回复很长。

## 根因

`withTimeout()` 是纯墙钟 race：定时器一响就 abort，**不看有没有进展**。
于是「慢但一直在输出 tool_use」与「真的卡死」被判成同一件事，而两者的下一步动作相反。

## What changed

```text
util/idle-guard.ts（新）
  · runWithIdleGuard：每拿到一条消息就重置静默计时；在 next() 上 race（不是只在循环体里检查）
  · startIdleWatchdog：给不能重构循环的调用点用（claude 的 for-await 属于这种）
  · IdleTimeoutError 带 kind=idle|hard-cap + 最后一条消息类型

cli.ts（claude 路径）
  · flags.timeout 语义：总时长 → **idle（无进展）上限**，默认仍是 300s
  · 新增 CLAUDE_HARD_CAP_MS：总时长硬上限，默认 30 分钟
  · 每收到一条 SDK 消息 poke 一次 watchdog
  · 重试按进展分流：idle 前已跑出过消息 ⇒ **不重试**（否则只是把静默乘 3）
  · 超时话术三态：有进展 / 零进展 / 撞硬上限 —— 三种给用户的话不同
  · includePartialMessages: true —— 长回答期间也产事件
```

## 行为对照

```text
改前：300s × 3 = 15 分钟静默 → "调用超时（300s × 3 attempts）"
改后：一直在动就一直跑；真卡住 → "连续 300s 没有任何进展（最后一条消息=tool_use），
      本次已跑出 N 条消息，故没有自动重试 —— 可以拆小任务，或点继续"
```

## Verification

```text
bun test src/util/idle-guard.test.ts          8 pass
  · 一直在动不超时（旧口径必红）· 一条不产立刻报错 · 中途停住报「最后一条消息」
  · 撞硬上限报 hard-cap · 两个计时都关 ⇒ 纯执行 · onItem 异常照常冒泡
  · watchdog：poke 重置 / 只触发一次 / idleMs<=0 永不触发
task-runtime-evidence 15 pass（确认没碰坏证据上报链路）
agent-node tsc：错误数 81（与 main 持平）
```

## 两个实测坑（写在代码注释里）

```text
① 只在循环体里检查没有用：真卡死是 for await 永远等不到下一条，循环体一次都不执行
   ⇒ 必须在 next() 上 race
② await iterator.return() 会把判定拖回原样：卡住的迭代器让 return() 挂到自己醒来，
   实测把「120ms 判定」变成「5000ms 才抛」⇒ 只发关闭请求，不 await
```

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.182
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.182
```

重启节点后生效。`flags.timeout` 的**语义变了**（总时长 → idle）：
把它调大不再是「让长任务跑完」的手段，详见 `docs/runbooks/claude-agent-sdk-timeouts.md`。

## What it does not do

- 不动 codex / grok 的超时口径（各自不同，且本轮没证据说它们有问题）
- 不改变「一条 result 就是一次最终答复」的既有契约
