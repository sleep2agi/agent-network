#!/usr/bin/env bash
# test720 — #720: codex co-presence nodes must not stop on 「Allow the commhub MCP server to
# run tool "<name>"?」. Real codex 0.133.0 and 0.159.2, real `codex app-server`, launched with
# the commhub `-c` overrides exactly as anet's launchers build them (emit-args.ts imports the
# shipped modules); fake model + fake commhub MCP (probe.mjs). Every assertion has a witnessed
# red: the control run (setting removed) must prompt, and each mutation of the shipped source
# must turn the suite red for that reason.
set -euo pipefail
cd /workspace
echo "T720 source=${T720_SOURCE_COMMIT:-unknown}"
if [ -n "${EXPECTED_SOURCE_COMMIT:-}" ] && [ "${T720_SOURCE_COMMIT:-}" != "$EXPECTED_SOURCE_COMMIT" ]; then
  echo "FAIL: source provenance mismatch image=${T720_SOURCE_COMMIT:-unset} expected=$EXPECTED_SOURCE_COMMIT"; exit 1
fi
SUITE=tests/test720-codex-commhub-tool-approval
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL $*"; }

echo "── L1 unit"
l1=0
(cd agent-network && bun test src/codex-commhub-mcp.test.ts) || l1=1
(cd agent-node && bun test src/runtime/codex-app-server/runtime.test.ts) || l1=1
if [ "$l1" -ne 0 ]; then echo "FAIL L1 unit — not running L2"; exit 1; fi
pass "L1 unit"

# args_for LAUNCHER [drop-approval] → NUL-separated argv on stdout
args_for() {
  local json
  json=$(T720_APPROVAL="${T720_APPROVAL:-on-request}" T720_SANDBOX="${T720_SANDBOX:-read-only}" bun "$SUITE/emit-args.ts")
  T720_JSON="$json" python3 - "$1" "${2:-}" <<'PY'
import json, os, sys
a = json.loads(os.environ["T720_JSON"])[sys.argv[1]]
if sys.argv[2] == "drop-approval":
    out = []
    i = 0
    while i < len(a):
        if a[i] == "-c" and "approval_mode" in a[i + 1]:
            i += 2; continue
        out.append(a[i]); i += 1
    a = out
sys.stdout.write("\0".join(a))
PY
}

# probe VERSION HOME LAUNCHER [drop-approval] → prints the T720_RESULT JSON
probe() {
  local ver=$1 home=$2 launcher=$3 mode=${4:-} argv=() out rc=0
  mapfile -d '' argv < <(args_for "$launcher" "$mode")
  out=$(node "$SUITE/probe.mjs" "/opt/codex-$ver/bin/codex" "$home" "$home/thread-id" -- "${argv[@]}" 2>&1) || rc=$?
  printf '%s\n' "$out" | grep '^T720_RESULT ' | sed 's/^T720_RESULT //' || true
  if [ "$rc" -ne 0 ]; then printf '%s\n' "$out" >&2; fi
}

# verdict JSON EXPECT(clean|prompted|blocked) → 0 when the run matches
verdict() {
  python3 - "$1" "$2" <<'PY'
import json, sys
raw, want = sys.argv[1], sys.argv[2]
try: r = json.loads(raw)
except Exception: print("  no result:", raw[:300]); sys.exit(1)
if want == "clean":
    ok = (not r["prompted"]) and r["toolRan"] and r["outputBack"] and r["turnDone"] and not r["errors"]
elif want == "prompted":
    ok = r["prompted"] and "Allow the commhub MCP server to run tool" in r["promptMessage"] and not r["toolRan"] and not r["outputBack"]
else:  # blocked: prompted OR silently declined — either way the commhub tool never ran
    ok = (not r["toolRan"]) and (not r["outputBack"]) and not r["errors"]
print("  ", {k: r.get(k) for k in ("prompted", "promptMessage", "toolRan", "outputBack", "turnDone", "resumed", "toolName", "declinedOutput", "errors")})
sys.exit(0 if ok else 1)
PY
}

fresh_home() { mktemp -d /root/t720-home.XXXXXX; }

# Postures (codex-copresence-profile.ts): read-only/on-request is the co-presence default;
# never/danger-full-access is the explicit grant; never/read-only shows approval_policy=never
# alone does not help. CONTROL = what the commhub call does WITHOUT the setting, measured:
#   on-request/read-only     → both versions prompt          (asserted: prompted)
#   never/read-only          → 0.133 prompts, 0.159.2 silently declines the call (asserted: blocked)
#   never/danger-full-access → both run the tool unprompted  (recorded only — not anet's to pin)
for ver in 0.133.0 0.159.2; do
  echo "── L2 real codex $ver"
  "/opt/codex-$ver/bin/codex" --version
  for posture in on-request:read-only:prompted never:read-only:blocked never:danger-full-access:info; do
    IFS=: read -r T720_APPROVAL T720_SANDBOX want <<<"$posture"
    export T720_APPROVAL T720_SANDBOX
    tag="$ver [$T720_APPROVAL/$T720_SANDBOX]"
    h=$(fresh_home); r=$(probe "$ver" "$h" posix drop-approval)
    how=$(printf '%s' "$r" | python3 -c 'import json,sys;r=json.load(sys.stdin);print("prompt" if r["prompted"] else ("ran" if r["toolRan"] else "declined"))' 2>/dev/null || echo "no-result")
    if [ "$want" = info ]; then
      echo "INFO $tag control (setting removed): $how"
    elif verdict "$r" "$want"; then
      pass "$tag control: setting removed → commhub tool blocked ($how)"
    else
      fail "$tag control: expected $want without the setting, got $how"
    fi

    h=$(fresh_home); r=$(probe "$ver" "$h" posix)
    if verdict "$r" clean; then pass "$tag POSIX launcher: fresh node, first commhub call runs, no prompt"; else fail "$tag POSIX fresh"; fi
    r=$(probe "$ver" "$h" posix)
    if verdict "$r" clean && printf '%s' "$r" | grep -Fq '"resumed":true'; then
      pass "$tag POSIX launcher: restart (same CODEX_HOME, thread resumed) → still no prompt"
    else fail "$tag POSIX restart"; fi

    h=$(fresh_home); r=$(probe "$ver" "$h" windows)
    if verdict "$r" clean; then pass "$tag Windows launcher (bare TOML values): no prompt"; else fail "$tag Windows"; fi

    h=$(fresh_home); r=$(probe "$ver" "$h" agentNode)
    if verdict "$r" clean; then pass "$tag agent-node owned app-server: no prompt"; else fail "$tag agent-node"; fi
  done
done
export T720_APPROVAL=on-request T720_SANDBOX=read-only

echo "── L3 mutations of the shipped source (each must go red)"
MOD=agent-network/src/codex-commhub-mcp.ts
RT=agent-node/src/runtime/codex-app-server/runtime.ts
CLI=agent-network/bin/cli.ts
# mutate NAME FILE PYTHON-REPLACE-FROM PYTHON-REPLACE-TO CHECK
mutate() {
  local name=$1 file=$2 from=$3 to=$4 check=$5 bak
  bak=$(mktemp); cp "$file" "$bak"
  python3 - "$file" "$from" "$to" <<'PY'
import sys
p, a, b = sys.argv[1:]
s = open(p).read()
assert s.count(a) == 1, f"mutation anchor not found exactly once in {p}: {a!r}"
open(p, "w").write(s.replace(a, b))
PY
  local red=0
  case "$check" in
    probe-posix) h=$(fresh_home); r=$(probe 0.159.2 "$h" posix); if verdict "$r" blocked; then red=1; fi ;;
    probe-agentNode) h=$(fresh_home); r=$(probe 0.133.0 "$h" agentNode); if verdict "$r" blocked; then red=1; fi ;;
    unit-an) (cd agent-network && bun test src/codex-commhub-mcp.test.ts >/dev/null 2>&1) || red=1 ;;
    unit-node) (cd agent-node && bun test src/runtime/codex-app-server/runtime.test.ts >/dev/null 2>&1) || red=1 ;;
  esac
  cp "$bak" "$file"; rm -f "$bak"
  if [ "$red" -eq 1 ]; then pass "mutation $name → red ($check)"; else fail "mutation $name stayed green ($check)"; fi
}
mutate M1-drop-setting "$MOD" '    `${COMMHUB_TOOLS_APPROVAL_KEY}=${q(COMMHUB_TOOLS_APPROVAL_VALUE)}`,' '' probe-posix
mutate M2-value-prompt "$MOD" 'COMMHUB_TOOLS_APPROVAL_VALUE = "approve"' 'COMMHUB_TOOLS_APPROVAL_VALUE = "prompt"' probe-posix
mutate M3-agent-node-drop "$RT" '    cfg.push("-c", `mcp_servers.commhub.default_tools_approval_mode="approve"`);' '' probe-agentNode
mutate M4-agent-node-drop-unit "$RT" '    cfg.push("-c", `mcp_servers.commhub.default_tools_approval_mode="approve"`);' '' unit-node
mutate M5-posix-launcher-inline "$CLI" 'codexCommhubMcpOverrides(opts.hub, "quoted")' '[`mcp_servers.commhub.url="${opts.hub}/mcp"`, `mcp_servers.commhub.bearer_token_env_var="ANET_CODEX_COMMHUB_TOKEN"`]' unit-an

echo "T720 PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
