# #179 R2 — Feishu PR #258 必改 1+2-C+3+dedup re-smoke

**Date:** 2026-06-24T15:34:04Z
**Branch HEAD:** 85538aa fix(#179 dedup + 必改3): bridge idempotency Set + TTL-bound user-visible timeout
**Expected HEAD:** 85538aa (4 new commits since R1: b875a16+81d11bc+85538aa stacked)
**Stack:** node v24.18.0 bun 1.3.14
**COMMHUB_DB:** /tmp/feishu-smoke-r2.db (R2 isolated from R1)

## R1 baseline re-run + R2 new regression matrix

| Level | Verdict | Note |
|---|---|---|
| Phase0 anet typecheck | PASS | rc=0 |
| Phase0 anet bun build worker.ts | PASS | worker.js 3609652 bytes |
| Phase0 anet bun test src/ | PASS |  |
| Phase0 agent-node bun test src/ | PASS | 221 pass / 1 fail (only known #204 prepareGrokIsolatedCwd, not #179) |
| Phase0 agent-node typecheck | SKIP | no tsconfig.json — bun runtime path |
| L0 env | PASS | node v24.18.0 bun 1.3.14 |
| L1 config + chmod 600 + access.json | PASS | mode=600, loader: {"ok":true,"appIdPresent":true,"allowFromCount":2} |
| L2 worker startup | PASS | 'bridge online' in stderr after ~8s + IPC=yes |
| L6 whitelist (config-level) | PASS | L6={"allowed":true,"denied":false,"chat":true} |
| L8 worker crash recovery | PASS | child.on('exit') fired — L8_EXIT={"c":null,"s":"SIGKILL"} |
| L9/L10 IPC round-trip | PASS | fork → {type:event} → {type:reply, eventKey===idempotencyKey, text=non-placeholder} |
| R2.1 必改1 checkAccess group-mentioned gate | PASS | {"pass":7,"fail":0,"total":7} — all 7 cases (DM+/-, group mentioned+/-, policy=all/observe, chat-not-in-allowChats) |
| R2.2 dedup idempotencyKey 2-min window | PASS | {"expected_invocations":2,"actual_invocations":2} — same key dropped 2x, distinct key fires once = 2 inner invocations expected |
| R2.3 必改3 TTL expire timeout-notify | PASS | {"total_sends":2,"a_sent":true,"a_was_timeout":true,"b_sent":true,"b_was_reply":true,"failures":0} — '[处理超时]' sent on expiry, reply takes precedence when in-time, no silent drop |

## Summary
- PASS: 13
- FAIL: 0
- SKIP: 1

**Net: ✅ all R1 baseline + R2 regression checks PASS — 4 必改 commits don't break prior gates, mentioned/dedup/timeout-notify all functioning per spec.**
