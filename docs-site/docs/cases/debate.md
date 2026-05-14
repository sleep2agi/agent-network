# 辩论赛 Demo

`anet demo debate` 是当前内置 demo：CLI 会创建 6 个临时 Agent，按 9 步驱动一场完整辩论，并输出 markdown 实录。

## 一句话跑

```bash
anet demo debate --topic "AI 创造的岗位是否比消灭的多"
```

预计 8-12 分钟跑完。需要先 `anet login` 到 hub，并准备 MiniMax API Key：

```bash
export MINIMAX_KEY=sk-cp-...
```

## 角色

| 角色 | 姓名 | 职责 |
|------|------|------|
| 主持人 | 周老师 | 开场介绍议题 + 闭幕回顾 |
| 正方一辩 | 林希 | 立论 + 总结陈词 |
| 正方二辩 | 陈一川 | 质询反方 |
| 反方一辩 | 沈墨 | 立论 + 总结陈词 |
| 反方二辩 | 白川 | 质询正方 |
| 评委 | 张教授 | 打分 + 宣判胜负 |

## 流程

1. 主持人开场
2. 正方一辩立论
3. 反方一辩立论
4. 正方二辩质询反方
5. 反方二辩质询正方
6. 反方一辩总结陈词
7. 正方一辩总结陈词
8. 评委打分判胜负
9. 主持人闭幕

加 `--quick` 走 4 步简化版（开场、双方立论、评委判分）。

## 参数

| Flag | 默认 | 说明 |
|------|------|------|
| `--topic <text>` | 交互输入 | 辩题 |
| `--key <key>` | `$MINIMAX_KEY` | MiniMax API Key |
| `--out <path>` | `./debate-<topic>-<ts>.md` | 实录保存路径 |
| `--keep` | false | 跑完保留 6 个临时 agent 和独立 network |
| `--quick` | false | 4 步简化版 |
| `--step-timeout <s>` | 360 | 每步超时秒数 |
| `--suffix <s>` | 随机 4 hex | alias 后缀 |
| `--no-network` | false | 跑在当前/default network 内 |
| `--network <id>` | 无 | 指定已有 network |

## Network 隔离

默认情况下，`anet demo debate` 会为每次运行创建独立 network：

1. 创建 `debate-<suffix>` network。
2. 将 6 个临时 agent provision 到这个 network。
3. 派发任务时带上 `network_id`。
4. 跑完删除 6 个 agent，并 cascade 删除独立 network 下的任务、inbox 和节点数据。

如果要把数据留在 Dashboard 里观察，使用：

```bash
anet demo debate --keep --topic "..."
```

如果要复用已有 network：

```bash
anet demo debate --network net_xxx --topic "..."
```

如果要退回旧行为，使用当前/default network：

```bash
anet demo debate --no-network --topic "..."
```

## 示例输出

```text
  辩题: AI 创造的岗位是否比消灭的多
  Hub:  http://127.0.0.1:9200
  Net:  (debate-1a2b net_xxx)
  Run:  1a2b

  [1/4] 创建 6 个 agent (alias 后缀 -1a2b)...
        ✓ 创建/更新 6 个 agent
  [2/4] 启动 6 个 agent (tmux session)...
        ✓ 6 agent 全部 SSE connected
  [3/4] 驱动辩论流程 (9 步)...
  [1/9] 开场 (主持人-1a2b) ... ✓ 21s, 361 字
  ...
  [4/4] 写入实录: ./debate-AI创造的岗位是否比消灭的多-1714766365.md
        ✓ 删除独立 network (net_xxx)
        ✓ 清理完成
```

## 故障排查

**缺少 MiniMax Key**

使用 `--key` 或 `MINIMAX_KEY`。当前 demo 走 MiniMax 的 Anthropic-compatible endpoint。

**每步 360s 超时**

首次启动 claude-agent-sdk runtime 可能需要 warm up。可以加大 `--step-timeout 600`，或先手动启动一次 agent 让运行时预热。

**想保留现场**

加 `--keep`，之后手动清理：

```bash
tmux ls | grep debate-<suffix>- | awk -F: '{print $1}' | xargs -I{} tmux kill-session -t {}
anet network delete net_xxx
```

## 下一步

**继续看 demo**：
- [Hello World](/cases/hello-world) — 最简 6 步起步 demo
- [翻译流水线](/cases/translation-pipeline) — 多 agent 串联流水线模式
- [Telegram 派遣队](/cases/telegram-squad) — 接入 Telegram 实时调度

**改造和深入**：
- 想换模型？看 [多模型对比](/guide/multi-model) — DeepSeek / GLM / Kimi / Claude 各家 Anthropic-compatible endpoint
- 想自己改 demo 行为？源码是 [`agent-network/bin/cli.ts` 的 `demoDebateCommand`（L3769）](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3769)（没有独立的 `src/commands/demo/` 目录，demo 逻辑都在 cli.ts 里）
- 想理解为啥每场都用独立 network 隔离？看 [网络与节点](/concepts/networks)

**用 Dashboard 观察**：
- 跑 `anet demo debate --keep` 保留现场 → 打开 [Dashboard](/guide/dashboard) → 在 Topology 里能看到 6 个 agent 的实时消息流
- 任务面板能逐步看完整 9 步驱动逻辑
