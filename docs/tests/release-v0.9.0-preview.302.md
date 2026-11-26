# commhub-server 0.9.0-preview.302

Since `.301`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.302
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.302
```

## What changed

```text
#3896（#5614）：Hub 的 15 个后台定时任务都计时，按 `JOB <name>` 记入 /api/stats/routes 分钟桶与
/health event_loop.recent_stalls[].top_routes。停顿时能直接看出是哪个后台任务在占事件循环。
只加计时，不改行为；抛错照常抛出并记一次 5xx。只发 server；agent-node / agent-network 不动
（仍为 2.5.0-preview.234 / 2.3.0-preview.270）。
```

## Verified

```text
#3896 新测试 route-timing-jobs 3/3；改到的模块测试全绿（route-timing 15、event-loop-lag 16、stale-sweeper 10、
retention 25、scheduled-tasks-http 17、push 26、retention-first-sweep-quiet 5、requirement-due-reminders-http 29、
task-orphan-http 9）。test831 pin 计数同步 4→3 / 14→12。
```
