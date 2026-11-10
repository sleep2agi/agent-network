# claude-agent-sdk 超时：三种「执行出错」怎么读

> 适用：节点 runtime = `claude-agent-sdk`，用户看到 `执行出错: …` 或日志里 `[claude]` 开头那几行。
> 由来：#4010（2026-11-06）。改之前只有一个数字（`300s × 3 attempts`），
> 而它把「没在动」和「动得太久」说成了同一件事 —— 这两件事要查的东西相反。

## 一句话判据

```text
看得见「最后一条消息=…」 ⇒ 它在动，卡在某一步  ⇒ 拆小任务 / 点继续
看得见「期间没有任何消息」 ⇒ 它没动，链路问题    ⇒ 查网络、ANTHROPIC_BASE_URL、vendor 状态
看得见「硬上限」           ⇒ 它在动，但总量太大  ⇒ 任务该拆
```

## 三种错误串

### ① 连续 idle 且**已有进展**（最常见）

```text
执行出错: 连续 300s 没有任何进展（最后一条消息=tool_use）— 本次已跑出 42 条消息，
故没有自动重试（重试只会让同样的静默再来一遍）。可以：把任务拆小，或点「继续」。
```

- 含义：模型跑到一半不吭声了（工具调用挂住 / 上游流断 / 长上下文截断）。
- 为什么**不重试**：已经跑出过消息 ⇒ 重试会在同一处再卡一次，用户侧只是把静默乘 3。
- 下一步：看节点日志 `[claude] idle …s 无任何消息（上限 300s，最后一条=tool_use）`
  前一条 `[claude] → xxx` 是哪个工具；那一步就是卡点。

### ② 连续 idle 且**零进展**

```text
执行出错: claude-agent-sdk 调用超时 (idle 300s / 硬上限 30min × 3 attempts) — 每次 …
```

- 含义：一条消息都没收到 ⇒ 连接/首包问题（URL 错、代理吞流、vendor 挂）。
- 会被自动重试（4s / 8s 退避）：这类是瞬时问题，重试有意义。
- 下一步：`curl -sS $ANTHROPIC_BASE_URL/v1/models -H "x-api-key: …"`；
  再看 `[claude] session=… model=…` 是否打出来 —— 一行都没打出来说明连 init 都没到。

### ③ 撞硬上限

```text
执行出错: … 硬上限 30min …
```

- 含义：一直在动，但总量超了 30 分钟。
- 下一步：拆任务。这不是链路问题，也不是卡死。
- 想临时放宽：`CLAUDE_HARD_CAP_MS=<ms>`（0 = 关闭，不推荐）。

## 两个旋钮

```text
flags.timeout / CLAUDE_TIMEOUT_MS   现在是 **idle（无进展）上限**，默认 300000（5 分钟）
CLAUDE_HARD_CAP_MS                  总时长硬上限，默认 1800000（30 分钟）
```

⚠️ `flags.timeout` 的语义在 `.275` 起变了（原来=总时长）。**把它调大不再是「让长任务跑完」的手段**：
长任务只要一直在动就不会被砍；调大它只会让「真卡死」更晚被发现。

## 相关

- `agent-node/src/util/idle-guard.ts`（判据实现 + 8 条测试）
- `agent-node/src/cli.ts` 的 `currentClaudeTimeoutMs()` / `currentClaudeHardCapMs()`
- 代码注释里记了两个实测坑：只在循环体里检查恒假；`await iterator.return()` 会把判定拖回原样。
