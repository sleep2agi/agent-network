# qa-rfc026-create-node — RFC-026 P1 e2e (Phase 0 scaffold)

End-to-end test harness for **RFC-026 P1 MVP** — dashboard 远程创建节点 + host-daemon. Coverage matrix lives in this scaffold; live impl scenarios light up after 通信牛 v3 re-judge PASSES + Phase 1-3 impl lands (per 安全 PR 不 bypass 红线).

## What this scaffold delivers (Phase 0)

- Dockerfile mirroring qa-rfc024 install pattern: bookworm-slim + bun + build-essential + python3 + local-source npm install for `anet` + `agent-node` (no `npx @preview` fallback, per RFC-024 教训)
- `run.sh` with **11 scenarios A-K** stubbed; every stub prints one line describing what it will assert
- structurally proves: docker build green + scaffold runs + framework can host the future live tests

## What it does NOT yet do

- No impl code under test (Phase 1-3 follow once 通信牛 PASS on RFC-026 v3 安全设计)
- All scenarios surface as `⊘ scaffold-stub`; first live impl scenario will be A (admin happy path) per 通信龙 milestone plan

## 11-scenario coverage matrix (full live impl matrix)

| # | Scenario | Live impl will assert | RFC § |
|---|---|---|---|
| A | admin create succeeds | curl /mcp create_node → daemon SSE → fork → child register → status=succeeded; child real `think()` smoke | §2.5 |
| B | member/viewer role gate | non-admin → 403 insufficient_role_for_create_node, no orphan row | §4.1.1 |
| C | cross-tenant SEC-1 | netA admin → netB daemon rejected; cross-net injection blocked; child ntok scope=caller_net | §4.3 |
| D | secret 不落库 (F1) | env_blob 不在 DB, env_keys-only 字段; hub Map evicted after daemon get | §4.4 |
| E | structured validation (F2) | name/runtime/flag 注入全拒; 0 shell; hub + daemon 双层 | §4.2.2 |
| F | daemon_max_children | N+1 rejected hub + daemon | §4.2.4 |
| G | env_refs strict (C1) | 5 sub-case + safe serializer escapes newline/quote | §4.4.7 |
| H | daemon node_id 强绑 (C2) | daemonB cannot get/ack daemonA's request | §4.1.4 |
| I | ANET_BIN PATH poison (C3) | pin'd absolute path; PATH 投毒不影响 fork | §4.2.6 |
| J | mint-evict 失败 (C4) | hub crash + daemon crash 双 case → orphan child-ntok revoke | §4.4.8 |
| K | channels fail-closed (C5) | non-empty channels rejected hub + daemon | §4.2.5 |

## Run

```bash
docker build -f tests/qa-rfc026-create-node/Dockerfile -t anet-rfc026-scaffold .
docker run --rm anet-rfc026-scaffold
```

Scaffold-stage exit = 0 means: docker build PASS + framework PASS + 11 stubs surface. **Does NOT mean impl works** — that requires the live impl scenarios under Phase 1-3.

## Lineage

- Mirror of `tests/qa-rfc024-config-apply/` install + Dockerfile pattern
- 11-scenario matrix per RFC-026 v3 §5 P1 test plan
- 通信牛 v3 re-judge gate per 安全 PR 不 bypass
