# commhub-server 0.9.0-preview.297

Since `.296`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.297
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.297
```

## What changed

```text
#3870 (#5502) 新增 POST /api/tasks/:id/recall：仅发送者本人或网络 owner/admin 可原子撤回未回复任务，
      保留 result = NULL、写入 meta_json.recalled/recalled_at/recalled_by 并清理未消费 inbox，
      已撤回幂等返回 200，终态返回 409 task_already_terminal。
```

## Verified

```text
#3870 定向 HTTP 集成测试 4/4 与 main 全量 CI 73/73 全部通过。
```
