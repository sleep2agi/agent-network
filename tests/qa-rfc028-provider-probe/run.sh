#!/usr/bin/env bash
# RFC-028 P1 e2e — provider & model registry + connectivity probe.
# Phase 0 scaffold: 7 scenarios stubbed (A-G), 2 boot tests (H, I)
# stubbed. Live impl lands phase-by-phase per 通信龙 milestone plan
# (M2a hub-side → A/B green, M2b daemon → C/D green, M3 integration +
# SSRF e2e → E/F/G/H/I green).

set -uo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/safe-rm.sh"

HUB_PORT=9236        # avoid 9235 (qa-rfc026) + 9200 (prod)
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=/tmp/qa-rfc028-hub.db
WORK=/tmp/rfc028-work

PASS=0; FAIL=0; SKIP=0
note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }
stub() { printf "  ⊘ %s — stub (Phase 0): %s\n" "$1" "$2"; SKIP=$((SKIP+1)); }

# ── Phase 0 stub: every scenario surfaces with what live impl will assert ──

note "A. vault write+read (encrypted-at-rest)"
stub "A" "upsert_network_secret(owner) → AES-GCM encrypted into network_secrets table; PRAGMA shows ciphertext BLOB not plaintext; list_providers returns secret_key_ref name but never value"

note "B. provider CRUD"
stub "B" "upsert_provider (admin) → providers row + provider_models rows; list_providers returns name/vendor/base_url/secret_key_ref + model list; delete_provider soft-delete (enabled=0)"

note "C. probe ok (mock vendor)"
stub "C" "probe_provider_model → daemon SSE type=probe_provider → daemon get_probe_request → undici dispatcher fetch mock (returns 200) → ack_probe_request status=ok + latency_ms; probe_results row status=ok"

note "D. probe auth_fail (mock 401)"
stub "D" "mock vendor returns 401 → daemon classifyProbeResponse status=auth_fail + raw_status_code=401; ack_probe_request white-list (NO error_message) → hub deriveErrorLabel = '「API key 校验失败 (HTTP 401)」'"

note "E. SSRF — redirect (3xx) 拒"
stub "E" "mock vendor returns 302 Location: http://169.254.169.254/ → daemon redirect:manual + 3xx-fail → ack status=redirect_forbidden; daemon never follows to metadata"

note "F. SSRF — private-IP / metadata 拒"
stub "F" "provider.base_url = http://169.254.169.254/ (cloud metadata) AND 10.0.0.1 / 127.0.0.1 (no loopback env) → daemon isForbiddenIp throws probe_resolve_unsafe_ip; ack status=tls_error or network_error; daemon NEVER reaches the IP"

note "G. secret-no-leak (rejectIfSecretLeaked guard)"
stub "G" "daemon constructed ack containing secret value (impl bug sim) → hub rejectIfSecretLeaked throws ack_secret_leak + audit row + drop ack; probe_results stays pending until reaper"

note "H. create-node #299 integration"
stub "H" "create_node with provider_id → hub resolves provider.secret_key_ref → auto-add to env_refs; child node config.env.ANTHROPIC_API_KEY populated; model validated against (provider_id, model_name) in provider_models"

note "I. boot-time TLS insecure env exit"
stub "I" "NODE_TLS_REJECT_UNAUTHORIZED=0 anet node start daemon → assertSecureTlsEnv throws probe_tls_insecure_disabled before any fetch; daemon exits fail-fast"

# ── Phase 0 sanity: docker built, framework OK ──
note "Phase 0 sanity"
ok "scaffold runs (live tests land per milestone plan)"

# Summary
printf "\n────────────────────────────────────────────\n"
printf "RFC-028 P1 e2e (Phase 0 scaffold) — PASS=%d FAIL=%d SKIP=%d\n" "$PASS" "$FAIL" "$SKIP"
printf "Stubs flip to live tests Phase 1-5 per 通信龙 milestone plan.\n"
printf "────────────────────────────────────────────\n"
[[ "$FAIL" -eq 0 ]]
