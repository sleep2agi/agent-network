# #498 hard-gate harness — `send_reply` tool description + warning field

**One-line purpose**: "改了文件" and "LLM 真的看得到" are two different things.
This harness verifies the *second one*.

## What broke on 2026-07-30 (why this exists)

The rule "回复 agent 之间用 `commhub_send_task`，不用 `commhub_reply`" was
documented in three places (`agent-network/bin/cli.ts` CLAUDE.md template,
Vincent's 2026-07-28 全网 broadcast, and prior incident postmortems) —
**but it was not in the MCP `tools/list` response the LLM reads when it
decides which tool to call**. Three separate agents in three days picked
the wrong tool because the rule was documented everywhere except the
decision point.

PR #502 put the rule into the tool description and added a runtime
`warning` field on the server response when the target alias resolves to
a real agent node. This harness locks in that fix at the transport
layer, complementing the in-tree regression test
(`server/src/send-reply-agent-warning.test.ts`).

## What this harness verifies (that unit tests do NOT)

| Layer                              | Unit test | This harness |
|------------------------------------|-----------|--------------|
| `send_reply` returns `warning` for real agent target | ✅ | ✅ |
| Description string in `tools.ts` reaches `tools/list` | ❌ | ✅ |
| MCP Streamable HTTP wire path serves the correct field | ❌ | ✅ |
| Behavior against a real hub process (not in-process handler) | ❌ | ✅ |
| Witnessed-red regression coverage | ✅ | ❌ |

**Run both.** The unit test catches "someone deleted the branch"; the
harness catches "someone rewired MCP transport / initializer / description
plumbing so the field never leaves the process."

## Run

```bash
./hardgate.sh
```

Requirements:
- `bun`, `python3`, `curl` on PATH
- Repo layout: harness sits at `docs/tests/p-498-reply-warning/`,
  the hub source at `server/` (three levels up)
- Free TCP port (default 9261 via `PORT=…` env)

What it does:
1. Boots an isolated `bun run server/src/index.ts` on `HOST=127.0.0.1`
   with its own `COMMHUB_DB`, `COMMHUB_UPLOADS_DIR`, and `HOME` — no
   touch of `~/.commhub/` production state.
2. Registers an admin user via `POST /api/auth/register`, captures the
   returned `network_token` (`ntok_...`).
3. Seeds a fake agent session + tasks directly into the isolated DB.
4. Drives an MCP client (`mcp-inspect.ts`) over Streamable HTTP:
   - `tools/list` → assert `send_reply.description` contains 5 phrases
   - `tools/call send_reply` → agent alias → assert `warning` field
     present + contains 5 action-pointing substrings
   - `tools/call send_reply` → `hub` alias → assert `warning` absent

The trap in `hardgate.sh` kills the hub and removes the isolated
temp dir on exit; nothing lingers.

## Expected output

```
=== HARD GATE 1: send_reply description phrases ===
  ✓ 'NOT for agent-to-agent replies'
  ✓ 'Use send_task for peer-to-peer replies'
  ✓ 'RFC-030'
  ✓ 'response includes a `warning` field'
  ✓ '全网规则'
Gate 1: 5 pass / 0 fail

=== HARD GATE 2A: send_reply → live agent alias ===
response payload: { ..., "warning": "Target \"test-agent-peer\" is an agent node. ..." }
✓ 'warning' field present
  ✓ warning contains 'commhub_send_task'
  ...
Gate 2A: 6 pass / 0 fail

=== HARD GATE 2B: send_reply → hub (Dashboard alias, no warning expected) ===
response payload: { "ok": true, "message_id": "...", "session_status": "unknown" }
✓ no 'warning' field (correct — hub is Dashboard path)
```

## Witnessed-red evidence

`witnessed-red.txt` — captured on 2026-07-30 when the warning branch was
temporarily reverted. The regression test `should include \`warning\` field`
fails at line 147:

```
error: expect(received).toBeDefined()
Received: undefined
```

Confirms the assertions are load-bearing, not shape-only.

## When to update this harness

- Any change to `server/src/tools.ts:send_reply` description
- Any change to the `warning` field logic in `send_reply`
- Any change to how MCP tools/list serialises tool descriptions
- Before landing a release that ships either of the above
