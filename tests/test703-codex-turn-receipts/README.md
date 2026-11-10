# test703 — Codex interrupted-turn receipts

Runs only in Docker. It covers the seven durable-ledger outcomes: completed,
still running, interrupted, missing, query failure, queued-delivery recovery,
and the 48-hour terminal fallback. The inspector pages to the exact original
turn and never calls `turn/start`. Fixture ids and aliases are synthetic.
