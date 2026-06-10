# qa-hub-18-delivery-semantics

Status: PASS

Date: 2026-06-10

Scope:

- #214 Wave 1 server delivery semantics.
- #168 server-side bad reply visibility.
- #172 missing/dead alias dispatch visibility.

Docker:

```bash
sg docker -c 'docker build -f tests/qa-hub-18-delivery-semantics/Dockerfile -t anet-qa-hub-18-delivery-semantics .'
sg docker -c 'docker run --rm anet-qa-hub-18-delivery-semantics'
```

Verified:

- REST `/api/task` to missing alias returns HTTP 404 with `alias_not_found` and does not queue.
- MCP `send_task` to missing alias returns `alias_not_found` and does not queue.
- REST `/api/task` to offline alias returns HTTP 202 with `alias_offline`, `queued:true`, and `task_id/message_id`.
- MCP `send_task` to offline alias returns `alias_offline`, `queued:true`, and writes task.
- MCP `send_message` separates missing alias from offline queued alias.
- `send_reply` with missing `in_reply_to` returns `reply_task_not_found`.
- `send_reply` on terminal task returns `reply_task_terminal` and does not overwrite task result.
