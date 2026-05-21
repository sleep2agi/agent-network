# QA Hub 17 — Rename Canonicalization Regression

Date: 2026-05-21
Result: PASS

## Scope

Regression coverage for #146/#172 rename canonicalization:

- committed `old_alias -> new_alias` rename chain resolution
- stale `report_status(old_alias)` after rename must not recreate old session rows
- REST `/api/task` old alias dispatch redirects to canonical alias
- MCP `send_task` old alias dispatch redirects to canonical alias
- `/api/status` cleans/filter committed old alias rows when the canonical row exists

## Command

```bash
sg docker -c 'docker build -t qa-hub-17-rename-canonicalization -f tests/qa-hub-17-rename-canonicalization/Dockerfile . && docker run --rm qa-hub-17-rename-canonicalization'
```

## Output

```text
Starting local CommHub for rename canonicalization QA
Register owner and create isolated network
1. Old alias reports online
2. Commit old-agent -> new-agent
3. New process reports under new alias
4. Stale old process heartbeat is ignored and cannot recreate old alias
5. REST /api/task to old alias redirects to new alias
6. MCP send_task to old alias redirects to new alias
7. Task/inbox rows only target canonical alias
PASS: rename canonicalization blocks stale report_status and redirects send_task/REST task
```

## Verified

- `report_status(old-agent)` after committed rename returns `ignored_stale_alias` and leaves only `new-agent` in `/api/status`.
- REST `/api/task` response includes `renamed_from=old-agent` and `renamed_to=new-agent`.
- MCP `send_task` response includes the same redirect metadata.
- `/api/tasks` contains `to_name=new-agent` and no `to_name=old-agent`.
