#!/usr/bin/env bash
# RFC-026 P1 create-node + host-daemon e2e — 11 scenarios A-K.
#
# This is the **Phase 0 scaffold** (通信龙 task 609da9ef): docker
# image builds + the scaffold runs + every scenario surfaces as a
# stubbed `⊘` skip with a one-line "what it will assert" so the
# 通信牛 re-judge can verify coverage shape WITHOUT impl code being
# present (test-first + 安全 PR 不 bypass).
#
# Real impl scenarios (curl /mcp create_node → daemon SSE → fork →
# real register → table state assertions) land in Phase 1-3 once
# 通信牛 re-judge PASSES per RFC-026 v3 (§5 P1 test plan).
#
# NB: in scaffold mode every scenario writes one line `⊘ <name> —
# stub: <what it will assert>` and exits 0; harness logs `PASS=0
# FAIL=0 SKIP=11` so a green build at this stage proves only that
# the framework + Dockerfile + 11-row matrix is structurally sound.

set -uo pipefail

HUB_PORT=9235   # avoid 9234 (qa-rfc024) + 9200 (prod)
HUB_BASE="http://127.0.0.1:$HUB_PORT"
PASS=0; FAIL=0; SKIP=0

note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }
stub() { printf "  ⊘ %s — stub (Phase 0 scaffold): %s\n" "$1" "$2"; SKIP=$((SKIP+1)); }

# ---- Scenario A: admin happy path ----
note "A. admin create succeeds end-to-end (real fork + real register)"
stub "A" "curl /mcp create_node → daemon SSE → fork → child register → status=succeeded; child real think() smoke"

# ---- Scenario B: role gate ----
note "B. member/viewer role gate"
stub "B" "non-admin utok → 403 insufficient_role_for_create_node; daemon never receives SSE; no orphan row in node_create_requests"

# ---- Scenario C: cross-tenant ----
note "C. cross-tenant SEC-1"
stub "C" "netA admin → netB daemon: rejected hub-side; cross-net spec injection rejected; child ntok scope = caller_net"

# ---- Scenario D: secret no-leak ----
note "D. secret 不落库 (F1 mint-stream-evict)"
stub "D" "sqlite3 SELECT * FROM node_create_requests → env_keys=[KEY_NAME] no env_blob field; hub Map evicted after daemon get (二次 get_create_request → not_found)"

# ---- Scenario E: structured validation (F2) ----
note "E. name/runtime/flag 注入 (F2)"
stub "E" "name=\";rm -rf /\" / runtime=bash / flags.maxTurns='DROP TABLE' all rejected; hub + daemon 双层校验; 0 shell, execFile array"

# ---- Scenario F: daemon_max_children ----
note "F. daemon_max_children backpressure"
stub "F" "fill daemon to max → N+1 hub-side rejected (reads nodes.current_children); daemon-side 兜底拒"

# ---- Scenario G: env_refs strict (C1) ----
note "G. env_refs 严格校验 (5 sub-case)"
stub "G" "G1 bad-regex / G2 dup / G3 over-max / G4 not-in-vault / G5 not-in-daemon-allowlist; G6 newline+quote in vault value → safe serializer escapes, no .env.local injection"

# ---- Scenario H: daemon isolation (C2) ----
note "H. daemon node_id 强绑 (C2)"
stub "H" "2 daemons same network; daemonB ntok calls get_create_request(daemonA-request) → 403 not_your_request; ack 同样拒"

# ---- Scenario I: ANET_BIN PATH poison (C3) ----
note "I. ANET_BIN absolute path 抗 PATH 投毒 (C3)"
stub "I" "place /tmp/evil-bin/anet (sleep 9999) + prepend PATH; daemon which-resolved /usr/local/bin/anet; fork child cmdline confirms real binary not evil"

# ---- Scenario J: mint-evict failure → orphan revoke (C4) ----
note "J. mint-evict 失败 → orphan child-ntok revoke (C4)"
stub "J" "J1 sim hub crash before get → boot sweeper revokes child-ntok + request status=failed; J2 sim daemon crash after get (kill -9) → reaper 60s revokes + status=expired"

# ---- Scenario K: channels fail-closed (C5) ----
note "K. channels fail-closed (C5)"
stub "K" "channels=[\"telegram\"] / [null] / [{}] → hub 拒 channels_not_supported_in_p1 + daemon 二次拒"

# ---- Summary ----
printf "\n────────────────────────────────────────────\n"
printf "RFC-026 P1 e2e scaffold — PASS=%d FAIL=%d SKIP=%d\n" "$PASS" "$FAIL" "$SKIP"
printf "Phase 0 scaffold complete: 11-scenario coverage matrix in place.\n"
printf "Stubs flip to live tests once 通信牛 re-judge PASSES on RFC-026 v3\n"
printf "and Phase 1-3 impl lands (per 通信龙 安全 PR 不 bypass 红线).\n"
printf "────────────────────────────────────────────\n"

# Exit 0 if no FAIL (skip-only at scaffold stage is OK)
[[ "$FAIL" -eq 0 ]]
