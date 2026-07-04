# RFC-029 PR④ — kernel-live ACP e2e verify snapshot

Real opencode-ai@1.17.13 driven by the real agent-node runtime
(`openOpencodeRuntime` + `opencodeThink` from #386), targeting one of
the opencode-zen free tier models. No mock at the vendor boundary.

## Reproduce

```bash
docker build -f tests/test-rfc029-pr4-kernel-live/Dockerfile -t anet-rfc029-pr4-live .
docker run --rm --tmpfs /tmp:rw,exec anet-rfc029-pr4-live
```

## Result (2026-07-04)

```
trailer: RFC-029 PR④ kernel-live — PASS
```

Structured harness output (verbatim from full-run.log):

```json
{
  "freeModel": "opencode/deepseek-v4-flash-free",
  "wallMs": 5718,
  "replyText": "hello world",
  "replyTextLength": 11,
  "thoughtTextLength": 94,
  "sessionId": "ses_0d571d710ffeeQgHa0262JnDNv",
  "chunks": 2,
  "thoughtChunks": 22,
  "stopReason": "end_turn",
  "rescued": false,
  "usage": {
    "inputTokens": 7723,
    "outputTokens": 3,
    "totalTokens": 7748,
    "thoughtTokens": 22
  },
  "pidsBefore": [],
  "pidsDuring": [45],
  "pidsAfter": [],
  "logsFromRuntime": ["[opencode-acp] session/new — ses_0d571d71..."]
}
```

## 8/8 assertions PASS

| # | Invariant                                              | Evidence                             |
|---|--------------------------------------------------------|--------------------------------------|
| 1 | opencode child present during turn (pgrep)             | pidsDuring=[45]                      |
| 2 | session id issued by real ACP `session/new`            | ses_0d571d710ffe…                    |
| 3 | at least one `agent_message_chunk` streamed            | chunks=2                             |
| 4 | replyText non-empty (real vendor produced text)        | replyTextLength=11                   |
| 5 | replyText looks like a real turn                       | replyText="hello world"              |
| 6 | stopReason recorded                                    | end_turn                             |
| 7 | no orphan opencode after `runtime.client.stop`         | pidsAfter=[]                         |
| 8 | wall time under 3-minute idle ceiling                  | wallMs=5718 (≈5.7s)                  |

## What this proves

- **Real ACP wire**: `openOpencodeRuntime` spawned `opencode acp`,
  handshook via `initialize`, established a session via
  `session/new`, and drove a turn via `session/prompt` — every frame
  is real ACP JSON-RPC 2.0, not synthesized.
- **Real vendor round-trip**: `usage.totalTokens=7748` came back from
  opencode-zen. The reducer accumulated real streaming
  `agent_message_chunk` notifications into `replyText`.
- **Real thinking + real reply**: the model emitted 22 thought chunks
  (`thoughtTextLength=94`) BEFORE the reply chunks. The runtime's
  #383 rescue path did not fire (`rescued=false`) because chunks
  arrived — the happy path is exercised end-to-end.
- **Clean process lifecycle**: opencode child (pid=45) was alive
  during the turn and gone after `runtime.client.stop()`. No orphan
  under `pgrep opencode`.
- **Free tier only**: `opencode/deepseek-v4-flash-free`, zero real
  vendor cost, and per §8 D5 the per-node `HOME` isolates
  `opencode.jsonc` selection so this container never touches a paid
  tier.

## Red-line 3-layer audit

- Broad private-fork keyword regex on diff = 0 hits
- Slug regex on diff + commit msg = 0 hits
- Real vendor key literal regex on diff + evidence = 0 hits
- Free-tier model only; no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in
  the container env or config; the shim's `authMethods` handshake
  path is never invoked (zen-free needs no login)
- No `Co-Authored-By` per project policy

## What still waits on Vincent's key

Real paid-vendor validation (Anthropic / OpenAI key) is not in this
harness — that's the P4-follow rally 通信龙 will dispatch once
Vincent's key lands. This round proves the ACP kernel; that round will
prove the paid-vendor auth path (`opencode auth login` + real
Anthropic model completion) end-to-end.
