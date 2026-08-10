# Mock LLM protocol for deterministic demos

This protocol is test infrastructure. It must not be enabled by a production
runtime implicitly. A demo or test opts in by setting
`MOCK_LLM_REPLIES_FILE` and sending prompts to the local reference server.

## Configuration

```bash
MOCK_LLM_REPLIES_FILE=/absolute/path/replies.jsonl \
MOCK_LLM_PORT=32100 \
bun tests/helpers/mock-llm-server.ts
```

The server binds only to `127.0.0.1`. `MOCK_LLM_REPLIES_FILE` is required;
startup fails before listening if the file is missing, is not a regular file,
is larger than 1 MiB, contains malformed JSON, or contains a rule with keys
other than `in_substring` and `out`.

`MOCK_LLM_PORT` is optional and defaults to `32100`. It must be an integer in
the range 1–65535.

`anet demo pr-review` also consumes this variable directly. In that mode the
CLI skips Hub, node, and vendor setup, but runs the same reviewer fan-out,
barrier, judge, and Markdown renderer as the real path:

```bash
MOCK_LLM_REPLIES_FILE=./demo-replies.jsonl \
  anet demo pr-review --diff ./change.diff --out ./review.md
```

The demo prefixes each lookup prompt with its role (`reviewer-security`,
`reviewer-performance`, `reviewer-style`, or `judge`) so a stateless fixture
can distinguish the otherwise identical reviewer task bodies.

## Rules file

The file is UTF-8 JSONL. Blank lines are ignored. Each non-blank line is one
exact rule:

```json
{"in_substring":"step-1 introduce yourself","out":"Hi, I am reviewer A."}
{"in_substring":"step-2 yesterday","out":"Yesterday I reviewed PR 42."}
```

Both values must be non-empty strings. Rules are evaluated in file order. The
first rule whose `in_substring` occurs in the prompt wins. Ordering is part of
the contract, so a broad rule placed before a narrow rule intentionally wins.

## HTTP surface

- `GET /health` → `{ "ok": true, "rules": N }`
- `POST /reply` with `{ "prompt": "..." }` →
  `{ "ok": true, "reply": "...", "matched": true|false, "rule_index": number|null }`

Other paths return 404. Invalid request JSON or a missing/non-string `prompt`
returns 400.

When no rule matches, the response is the exact fallback
`(mock LLM: no rule matched)` and the server writes a warning to stderr. A
fallback is therefore visible while still letting a demo finish.

## Multi-turn behavior

The resolver is deliberately stateless. It has no cursor, consumed flag, or
per-client state. Repeating the same prompt returns the same reply, including
under parallel use or after a server restart.

Multi-turn demos encode a stable discriminator such as `step-1`, `step-2`, or
`turn-3` in each prompt and provide one rule per discriminator. This avoids
shared cursor races and makes every response derivable from the request plus
the immutable rules file.

## Integration boundary

The HTTP server and `anet demo pr-review` use the same parser and resolver.
They activate only when `MOCK_LLM_REPLIES_FILE` is explicitly present. Normal
agent-node execution, non-demo commands, and an unset demo invocation continue
to use their configured Hub and real provider. Never ship a rules file or use
the fallback text as an automatic response to a real provider failure. This
mock proves deterministic orchestration, not vendor credentials or reachability.
