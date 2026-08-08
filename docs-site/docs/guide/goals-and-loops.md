# Goal 与 Loop

`/loop` 是 Agent Network 的周期调度命令；`/goal` 目前同时承载一条兼容路径和一条 Codex TUI 路径。为了避免歧义，新的周期任务统一使用 `/loop`。

## 先看结论

| 输入位置 | `/loop` | `/goal` |
|---|---|---|
| 认证 Dashboard Chat → 共享 Codex TUI（`codex-app-server`） | 创建 anet 周期任务 | 进入共享 Codex 线程，作为一次性目标执行 |
| 其他 agent-node 收件入口 | 创建 anet 周期任务 | `/loop` 的旧兼容别名，同样要求间隔 |
| `anet node loop` | 始终发送 `/loop` | 不使用 |

“认证 Dashboard Chat”不是按发送者名字猜测的。Hub 会写入经认证的来源元数据；旧数据、普通节点消息或伪造字段不会获得这条特殊路由。

如果在 Dashboard 的共享 Codex TUI 中输入 `/goal 5m 检查日志`，它仍是一次性目标，不会变成周期任务。回复会附带提示，要求定时任务改用 `/loop`。

## 创建周期任务

最简单的外部命令是：

```bash
anet node loop my-agent "检查待处理 Issue" --every 5m
```

`--every` 可用 `m`、`h`、`d`，例如 `5m`、`2h`、`1d`；省略时默认 `5m`。命令先把 `/loop` 投递给在线节点，再等待最多 15 秒的创建回执。只排入 Hub 队列不算创建成功。

在 Dashboard Chat、CommHub 任务或其他能向节点投递文本的入口，也可以直接发送：

```text
/loop 5m 检查待处理 Issue
/loop 每小时汇总一次进展
/loop daily 生成日报
```

文本解析器支持分钟、小时、天以及 `hourly`、`daily`；最短间隔为 1 分钟。裸数字和秒级间隔会被拒绝。

::: warning Claude Code CLI 是另一套宿主
本页的 `goals.json`、`anet goal` 和自管理工具描述的是 agent-node 调度器。独立的 `claude-code-cli` 会话有 Claude Code 自己的 `/loop`，不由这份本地 goal 状态管理。
:::

## 每轮如何执行

节点启动时加载自己的 goal 存储。调度器默认约每 30 秒检查一次到期项，因此 `/loop` 不是高精度 cron；一次执行耗时也可能让实际时间进一步后移。

每次到期后，节点会：

1. 把本轮 wake 写入进度记录；
2. 给模型注入目标、周期和最近 5 条进度；
3. 要求模型检查真实状态并做一次增量推进；
4. 保存回复摘要、失败次数和下一次唤醒时间；
5. 对从任务创建的 loop，尝试向原发送者汇报。

只有模型在独立一行输出 `GOAL_COMPLETE`、`GOAL COMPLETE` 或 `目标已完成`，调度器才会自动标记完成。普通报告里的 “completed” 或“已完成 3 项”不会误停循环。

连续失败默认达到 5 次时，goal 会自动变为 `paused`，避免无限重试消耗额度。修复原因后可恢复；每次成功执行会重置连续失败计数。

## 查看和管理

```bash
anet goal list [node]
anet goal show <node> <goal-id>
anet goal wake-log <node> <goal-id> [--tail N] [--json]
anet goal edit <node> <goal-id> --interval 10min
anet goal edit <node> <goal-id> --text "新的任务描述"
anet goal edit <node> <goal-id> --status paused
anet goal cancel <node> <goal-id>
```

`goal-id` 可使用能唯一匹配的前缀。常见状态如下：

| 状态 | 含义 |
|---|---|
| `active` | 会被调度 |
| `paused` | 保留但不唤醒，可恢复 |
| `complete` / CLI 兼容值 `completed` | 目标已完成，终态 |
| `failed` | 不可恢复的失败，终态 |
| `cancelled` | 已取消，终态 |

`anet goal show` 只展示最近 10 条进度；需要完整历史或脚本消费时使用 `wake-log`。

### 运行中修改的限制

`anet goal edit` 和 `anet goal cancel` 直接改本机文件。运行中的 agent-node 以已加载的内存状态为准，不会热重载外部修改；修改后需要重启该节点。`list`、`show` 和 `wake-log` 是只读命令。

若希望运行中立即修改，优先让节点调用下面的自管理工具。

## Agent 自管理工具

支持自管理工具的 agent-node runtime 会看到六个只作用于“自己”的工具：

| 工具 | 作用 |
|---|---|
| `list_my_loops` | 列出自己的 loop |
| `create_my_loop` | 创建 interval、每天定点或 weekday 计划 |
| `edit_my_loop` | 修改任务、计划或暂停状态 |
| `reschedule_my_loop` | 只推迟下一次 wake，不改长期周期 |
| `complete_my_loop` | 标记目标达成 |
| `cancel_my_loop` | 取消目标 |

这些工具不接受 alias 参数，不能管理其他节点。当前它们接入 `claude-agent-sdk`、`codex-sdk`、`codex-app-server` 和 Grok agent-node 路径；OpenCode 与独立 `claude-code-cli` 不使用这套自管理工具。

自管理工具还有三道保护：每节点默认最多 20 个 active goals；同一 goal 修改后有 30 秒冷却；30 秒内连续批量取消会要求二次确认。

结构化计划支持：

- `interval`：固定间隔，最短 60 秒；
- `time_of_day`：每天某个 `HH:MM`；
- `weekday`：指定星期与 `HH:MM`。

定点计划默认使用节点 `flags.timezone`，未配置时为 `Asia/Shanghai`。`anet node loop` 与 slash 文本目前只创建 interval；定点/星期计划通过自管理工具创建。

## 存储、重启和 runtime 切换

每个节点的状态保存在：

```text
.anet/nodes/<node>/goals.json
```

agent-node 的存储写入采用临时文件加原子 rename，并把文件权限收紧为 `0600`。`anet goal edit/cancel` 是另一条本地文件写入路径；在多用户主机上执行后，应随节点重启一并确认 `goals.json` 仍为仅 owner 可读写。格式损坏时，节点会保留 `.corrupt.<timestamp>` 副本并以空存储继续启动。

goal 在节点重启后会继续生效；节点离线期间不会执行，恢复后到期的 active goal 会在下一次调度检查中运行。若节点切换到不兼容的 runtime bucket，active goals 会被归档到 `.runtime-switched.<timestamp>`，新 runtime 从空存储启动，避免跨 SDK 复用不兼容的 thread/session ID。

## 排查

```bash
anet goal list <alias>
anet goal show <alias> <goal-id>
anet goal wake-log <alias> <goal-id> --tail 20
anet info <alias>
anet logs <alias> --follow
```

重点检查：节点是否在线、状态是否仍为 `active`、`next_wake_at` 是否到期、是否连续失败后自动暂停，以及本机正在看的项目目录是否真的是该节点的状态目录。

循环会真实消耗模型额度。先用较长周期试跑，确认停止条件和汇报内容后再缩短间隔。
