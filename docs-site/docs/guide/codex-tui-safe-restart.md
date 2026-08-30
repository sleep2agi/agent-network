# Codex TUI 节点安全重启 Runbook

本页适用于任何使用 `codex-app-server` / Codex TUI 共存形态的 anet 节点。目标不是“进程重新出现”，而是确认同一个节点身份、同一个 Codex thread、同一个工作目录和同一份主 rollout 都被恢复。

::: danger 停止条件
任一身份、目录、thread、rollout、goal 或在线状态不一致时，立即停止继续操作。修复后从验收清单重新做完整核对，不要只补一项。
:::

## 通过标准

恢复成功必须同时满足：

- 目标节点身份可用，Hub 上的 `from_name` / `from_node_id` 与预期节点一致。
- Codex TUI 恢复的是完整的原 thread ID，不是短前缀匹配，也不是最近会话。
- 主 rollout 文件没有缩小、没有被替换，且内容对应原 thread。
- app-server、TUI 和 bridge 都使用目标节点的工作目录。
- CommHub `project_dir`、Codex TUI `-C` 和节点配置中的工作目录一致。
- 原 goal 状态被保留：active 的重启后继续运行，paused 的仍保持 paused。
- app-server、TUI 和 bridge 三类进程都在线，且 Hub 显示目标节点在线或 idle。

仅看到进程存在不算恢复成功。

## 1. 重启前冻结现场

对每个 alias 单独记录一份表，不要把多个节点混在一起：

| 项 | 必须记录 |
|---|---|
| 节点身份 | alias、node_id、独立 `CODEX_HOME` |
| 工作目录 | 预期项目目录的绝对路径 |
| Codex thread | 完整 36 位 session / thread ID |
| 主 rollout | 绝对路径、字节数、简短内容摘要 |
| goal 状态 | active、paused、完成或取消；paused 的原因也记录 |
| app-server | 实际子进程命令行、cwd、环境中的目标 `CODEX_HOME` |
| TUI | 实际子进程命令行，必须包含 `-C <节点工作目录>` |
| bridge | 实际子进程命令行、cwd、CommHub `project_dir` |

检查“真正子进程”，不要只看外层启动器、tmux 名称或 supervisor 进程。需要确认 app-server、TUI、bridge 子进程都使用目标节点的令牌、目标节点的 `CODEX_HOME` 和目标工作目录。

## 2. 备份凭据，保护权限

重启、迁移或 fork 节点前先备份目标节点的 Codex 凭据文件，例如节点专属 `CODEX_HOME` 下的 `auth.json`。复制后立即设置为只有当前用户可读写：

```bash
chmod 0600 <node-codex-home>/auth.json
```

凭据、bearer token、`ntok_` 或 `atok_` 绝不能进入命令行参数、日志、聊天、PR、任务回执或截图。需要传递 secret 时使用受保护的文件、环境变量引用或平台 secret store。

## 3. 按顺序停止旧拓扑

停止顺序：

1. bridge
2. TUI
3. app-server

tmux session 退出后还要检查孤儿子进程和孤儿监听端口。端口仍在监听、旧 bridge 仍连接 Hub、或旧 TUI 仍持有原 thread 时，不要启动新拓扑。

如果用 anet 管理节点，优先从共存进程树外运行：

```bash
anet node stop <alias>
```

然后核对 tmux session、进程树和 loopback 监听状态都已清理。

## 4. 按相反顺序启动

启动顺序：

1. app-server
2. TUI
3. bridge

app-server 和 TUI 都必须显式使用目标节点独立的 `CODEX_HOME`。TUI 必须显式指定工作目录：

```bash
codex resume --remote <app-server-url> <full-thread-id> -C <node-cwd> -m <model>
```

bridge 启动前必须先 `cd` 到目标节点工作目录。启动后核对三处一致：

- CommHub 报告的 `project_dir`
- TUI 命令行里的 `-C <node-cwd>`
- 节点配置中的工作目录

三者任一不同都视为恢复失败。

## 5. 只恢复 exact session

禁止使用短前缀、最近 session、交互 picker 或“看起来像同一个”的历史会话。必须把完整 36 位 thread ID 传给 `resume`。

相同 thread ID 在不同 `CODEX_HOME` 中可能合法存在，所以验收不能只看 thread ID。还必须同时核对 `CODEX_HOME`、主 rollout 路径、主 rollout 大小、工作目录和节点身份。

side-thread 新文件不能替代主 session 验收。新生成的 rollout 只说明创建了新会话，不说明原会话恢复成功。

## 6. 核对 rollout 没有回退

resume 前检查主 rollout：

```bash
wc -c <main-rollout-file>
sed -n '1,40p' <main-rollout-file>
tail -40 <main-rollout-file>
```

重启后再次检查同一条绝对路径。字节数不得缩小，路径不得换成新的 side-thread 文件，内容应继续对应原 thread。若文件缩小、替换、消失或内容不连续，立即停止并回到启动前记录核对。

## 7. 保持原 goal 状态

不要把重启当作清空任务状态。

- 重启前是 active 的 goal，恢复后必须继续运行。
- 重启前是 paused 的 goal，恢复后必须保持 paused。
- 如果自动续跑误触发了本该 paused 的 goal，立即暂停它，并把原因记录到验收结果。

重启过程不要为了探活而发送会改变状态的任务。

## 8. 使用无副作用登录探针

验证身份时，只发送固定、短、无副作用的探针，例如要求节点返回一个固定短语或读取自身只读状态。不要在探针里要求修改文件、刷新凭据、停止进程、切换 goal 或调用外部系统。

最终身份验收必须由目标节点自己发起一条任务或回执，再从 Hub 核对发送字段：

- `from_name`
- `from_node_id`
- 目标 network / project 信息

如果接收端模型、工具或权限返回 4xx，只能说明接收链路失败；只要 sender 字段正确，发送身份仍可判定通过。不要把接收端 4xx 误判成发送身份错误。

## 9. 完整验收清单

单节点 canary 通过后，再逐节点执行同一套流程。最后 fresh 拉全体状态验收。

| 检查项 | 判定 |
|---|---|
| app-server | 进程在线；实际子进程使用目标 token、`CODEX_HOME`、cwd |
| TUI | 进程在线；命令行包含完整 thread ID 和 `-C <node-cwd>` |
| bridge | 进程在线；从目标 cwd 启动；CommHub `project_dir` 正确 |
| session | 完整 36 位 thread ID 与重启前一致 |
| rollout | 同一绝对路径；字节数未缩小；内容未被新 thread 替换 |
| 身份 | Hub 上 `from_name` / `from_node_id` 与目标 alias / node_id 匹配 |
| 状态 | Hub 显示节点 online / idle，且没有旧实例重复连接 |
| goal | active 继续，paused 保持 paused，没有意外续跑 |
| 凭据 | `auth.json` 权限为 `0600`，secret 未出现在 argv、日志或回执 |

任何一项失败都回到停止条件处理。

## 10. 记录结果

验收记录应包含通用事实，不包含 secret：

- alias 与 node_id 的脱敏标识或内部工单引用。
- 重启前后的 thread ID 核对结果，必要时只记录哈希或尾部校验。
- rollout 路径类别、字节数前后对比和“未缩小”结论。
- 三进程命令行是否对齐到同一 `CODEX_HOME`、cwd 和 project_dir。
- goal 状态是否符合预期。
- 登录探针的 Hub sender 字段核对结果。
- 是否发现孤儿进程、孤儿端口或 side-thread。

公开文档、issue、PR 和 release note 只能保留这些通用原则；不要写入内部路径、内网地址、机器别名、端口、指纹、session 原文或生产 SHA。
