# codex-app-server 节点「静默卡死」诊断与重启 SOP

长时间运行的 codex-app-server 节点会出现**静默卡死**：进程活着、hub 心跳新鲜、healthz 绿，
但当前 turn 永远不结束——发给它的任务全部 `queued (a turn is in flight)` 然后 600s 超时。
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

## 重启步骤

```bash
# 1. 有界终止（先 TERM，4s 后仍在才 KILL）
kill -TERM <agent-node pid>; sleep 4
ps -p <pid> >/dev/null && kill -9 <pid>

# 2. 清 codexThreadId（防 resume 中毒——旧 thread 可能就是卡死源），务必先备份
cp <node-config>.json <node-config>.json.bak-jam-$(date +%H%M)
#    （编辑 JSON：删除 codexThreadId 字段，其余不动）

# 3. 原会话原命令重启（tmux send-keys 回原 pane）
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
