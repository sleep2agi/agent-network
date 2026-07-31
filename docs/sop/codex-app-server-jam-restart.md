# codex-app-server 节点「静默卡死」诊断与重启 SOP

长时间运行的 codex-app-server 节点会出现**静默卡死**：进程活着、hub 心跳新鲜、healthz 绿，
但当前 turn 永远不结束——发给它的任务全部 `queued (a turn is in flight)` 然后在默认 600s 等待窗超时（该默认值可覆盖）。
节点从此"永远听不见"任何新指令。

## 先诊断，别急着杀（两次真实案例的教训）

超时消息 ≠ 卡死（见 [推送语义](./agent-reply-to-dashboard.md)）。按顺序验证：

1. **capture-pane 看终端实况**：`tmux capture-pane -t <会话名> -p | tail -30`
   - 有新输出/工具调用在滚 → **在干活，别动它**（大 turn 可以合法跑很久）
2. **看它的工作目录是否还在变**：`git -C <工作区> status --porcelain | wc -l` 隔几分钟对比
   - 输出静止 + 工作区静止 ≥1 小时 → 基本坐实卡死
3. **hub 心跳**只证明 bridge 活着，不证明 LLM turn 活着——不要作为"没卡"的依据

## 重启前：保全工作

卡死 turn 的中间产物通常已在磁盘（工作区/worktree）。先快照/提交/开 draft PR 保全，
再重启——**顺序不能反**，重启不丢磁盘内容，但保全在先是零风险。

## 重启步骤：一等 `--copresence` 节点

先在 TUI 中 `Ctrl-B D` detach，再从**共存进程树外的 shell**运行。不要使用日志里可能出现的通用提示 `anet node start <alias>`；普通 start 会另起一个非共存节点，与旧 bridge 争抢同一 alias（[#535](https://github.com/sleep2agi/agent-network/issues/535)）。

```bash
# 1. 停完整三件套（app-server / bridge / TUI）
anet node stop <alias>

# 2. 回到正确项目；thread cwd 继承 app-server 的 cwd，不是 bridge 的 cwd
cd <project-dir>

# 3. 清调用 shell 继承的全部身份变量，不能逐个列举
for v in $(env | sed -n 's/^\(COMMHUB_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

# 4. 必须仍走共存入口；它会创建新 thread 并写回 config
anet node start <alias> --copresence
tmux attach -t <alias>
```

验证：TUI/bridge pane 有新输出，hub 心跳刷新；Linux 上再用 `readlink /proc/<app-server-pid>/cwd` 确认 app-server cwd 是目标项目。不要只查 bridge。

## 手工 shared/adopt 或普通 owned 节点

没有 `--copresence` marker 的旧拓扑才走下面的有界终止与手工清 thread：

```bash
# 1. 有界终止（先 TERM，4s 后仍在才 KILL）
kill -TERM <agent-node pid>; sleep 4
ps -p <pid> >/dev/null && kill -9 <pid>

# 2. 清 codexThreadId（防 resume 中毒——旧 thread 可能就是卡死源），务必先备份
cp <node-config>.json <node-config>.json.bak-jam-$(date +%H%M)
#    （编辑 JSON：删除 codexThreadId 字段，其余不动）

# 3. 用原拓扑的完整命令重启；shared/adopt 不得丢 URL/thread 身份
# 4. 验证：pane 出现 created thread/SSE connected；hub /api/status 心跳刷新
```

## 快照竞态警告（真实案例）

「先保全再重启」的快照可能**跟垂死 turn 的最后写入竞态**：实测重启前后 workspace 又多了 3 个
文件的写入（其中一个还是安全相关修复）。所以：**重启完成、节点稳定后，必须把保全物（分支/PR）
与 workspace 重新逐文件 diff 一次**（tree hash 对比最稳），有漂移以 workspace 较新版本为准补齐。
不做这步，保全物可能悄悄少了最后几笔关键修改。

## 重启后

- 任务**拆小步重喂**（一步一报），避免又进一个几小时的大 turn
- 提醒节点：回报用 send_task 或终态 reply（其它通道不推送）
