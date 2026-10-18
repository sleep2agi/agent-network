#!/usr/bin/env bash
# test1313 / #1313 — Linux host-shared OpenCode server OBSERVATION PROVIDER.
#
# Isolated suite: `--network none`, no credentials, no daemon, no lifecycle.
# It exercises a read-only /proc observer against REAL listening processes.
set -euo pipefail
unset TMUX TMUX_PANE
# 2026-06-16 incident guard: never a bare `rm -rf $VAR` in tests/ (see
# tests/lib/safe-rm.sh). Explicit /tmp so safe_rm_rf's allow-list holds.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
export ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
mkdir -p "$ARTIFACT_DIR"
exec > >(tee "$ARTIFACT_DIR/report-test1313-runtime.txt") 2>&1
echo "test1313 host-shared OpenCode observation provider source=${SOURCE_COMMIT:-unset} date=$(date -Is)"
if [[ -n "${EXPECTED_SOURCE_COMMIT:-}" ]]; then test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"; fi

cd /opt/node_modules/@sleep2agi/agent-node

echo 'L0 + real processes: reason coverage, and REAL listeners (argv classified as a diagnostic)'
bun test src/runtime/opencode-host-shared-observer.test.ts

echo 'guard: the observer stays inside read-only /proc observation; argv is diagnostics only'
# Comments explain what is NOT evidence (registry path, clientBinDir, binary
# name) — strip them so the check is about code, not prose.
strip_comments() { awk '{ sub(/\/\/.*/, "") } { print }' "$1"; }
# It may not reach for credentials, the registry, or the daemon create path.
if strip_comments src/runtime/opencode-host-shared-observer.ts \
   | grep -nE "passwordFile|opencode-shared-server\.json|create-node-daemon|clientBinDir"; then
  echo 'FAIL: observer reaches outside read-only /proc observation (credential/registry/daemon/path surface)' >&2
  exit 1
fi
# It must not depend on the reuse-decision slice: the evidence type is defined locally.
if strip_comments src/runtime/opencode-host-shared-observer.ts | grep -nE "opencode-server-reuse|decideHostSharedServerAdmission"; then
  echo 'FAIL: observer leans on the reuse decision — #1313 must stay independent of #2777' >&2
  exit 1
fi
# And it must never promote an argv shape into a proven generation: no
# `generation:` property may be declared (an injected *parameter* named
# `generation` in the diagnostics hook is fine — anchored at the line start).
if strip_comments src/runtime/opencode-host-shared-observer.ts \
   | grep -nE "^[[:space:]]*generation[[:space:]]*\??[[:space:]]*:"; then
  echo 'FAIL: evidence claims a generation field — argv is a diagnostic, not proof' >&2
  exit 1
fi
# Witnessed-red for that check: the same pattern must fire on a declared field.
if ! printf 'export interface X {\n  generation: "v1" | "v2";\n}\n' \
   | grep -qE "^[[:space:]]*generation[[:space:]]*\??[[:space:]]*:"; then
  echo 'FAIL: the generation-field check cannot witness a violation' >&2
  exit 1
fi
if ! strip_comments src/runtime/opencode-host-shared-observer.ts | grep -q "processEvidence"; then
  echo 'FAIL: the provider must return processEvidence' >&2
  exit 1
fi
if ! strip_comments src/runtime/opencode-host-shared-observer.ts | grep -q "argvContractNote"; then
  echo 'FAIL: diagnostics must state that the argv shape proves nothing' >&2
  exit 1
fi

echo 'cross-uid: the uid reported is the HOLDER process uid, not the socket creator uid'
# 通信牛's counterexample (#2784 review): a process can create the listening socket
# as root (so /proc/net/tcp reports uid 0) and then drop to 65534, or a child can
# inherit / receive the fd (SCM_RIGHTS). Filtering candidates by the socket uid
# would MISS the real holder and wrongly answer `socket_owner_not_found`.
command -v setpriv >/dev/null || { echo 'FAIL: setpriv missing - the cross-uid control cannot run' >&2; exit 1; }
tmp=$(mktemp -d /tmp/test1313.XXXXXX); chmod 755 "$tmp"; mkdir -p "$tmp/home"; chmod 777 "$tmp/home"
OBS_MODULE=/opt/node_modules/@sleep2agi/agent-node/src/runtime/opencode-host-shared-observer.ts
trap 'kill "$holder_pid" 2>/dev/null || true; kill "$foreign_pid" 2>/dev/null || true; safe_rm_rf "$tmp"' EXIT

cat > "$tmp/dropper.ts" <<'TS'
const port = Number(process.argv[2]);
Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
process.setuid(65534); // socket keeps the root creator uid; the process does not
await new Promise(() => {});
TS
port=$((20000 + RANDOM % 20000))
bun "$tmp/dropper.ts" "$port" & holder_pid=$!
hexport=$(printf '%04X' "$port")
for _ in $(seq 1 60); do
  grep -q "0100007F:$hexport .* 0A " /proc/net/tcp && break
  sleep 0.25
done
grep -q "0100007F:$hexport .* 0A " /proc/net/tcp || { echo "FAIL: dropped-uid listener on :$port never listened" >&2; exit 1; }
socket_uid=$(awk -v want="0100007F:$hexport" '$2==want && $4=="0A" {print $8}' /proc/net/tcp | head -1)
proc_uid=$(stat -c '%u' "/proc/$holder_pid")
echo "   setup: socket uid=$socket_uid, holder process uid=$proc_uid (they differ: the point of the control)"
[[ "$socket_uid" != "$proc_uid" ]] || { echo "FAIL: control setup did not produce differing uids" >&2; exit 1; }
# root reader, no CAP_SYS_PTRACE: the holder's fds are unreadable => uniqueness is
# unprovable => permission_denied. `socket_owner_not_found` would be a false claim.
OBS_URL="http://127.0.0.1:$port" OBS_MODULE="$OBS_MODULE" bun /test1313/cross-uid.ts \
  "http://127.0.0.1:$port" "$proc_uid" socket_owner_not_found
kill "$holder_pid" 2>/dev/null || true; wait "$holder_pid" 2>/dev/null || true

# A foreign-uid listener observed by the same uid reader: still a mixed-uid table
# (root processes are unreadable from here), so the honest answer is a refusal.
cat > "$tmp/opencode" <<'JS'
#!/usr/bin/env bun
const argv = process.argv.slice(2);
const i = argv.indexOf("--port");
Bun.serve({ hostname: "127.0.0.1", port: Number(argv[i + 1]), fetch: () => new Response("ok") });
await new Promise(() => {});
JS
chmod 755 "$tmp/opencode"
port2=$((20000 + RANDOM % 20000))
as_nobody=(setpriv --reuid=65534 --regid=65534 --clear-groups env HOME="$tmp/home" OBS_MODULE="$OBS_MODULE")
"${as_nobody[@]}" "$tmp/opencode" serve --hostname 127.0.0.1 --port "$port2" & foreign_pid=$!
hexport2=$(printf '%04X' "$port2")
for _ in $(seq 1 60); do
  grep -q "0100007F:$hexport2 .* 0A " /proc/net/tcp && break
  sleep 0.25
done
OBS_URL="http://127.0.0.1:$port2" "${as_nobody[@]}" bun /test1313/cross-uid.ts \
  "http://127.0.0.1:$port2" 65534 socket_owner_not_found

echo 'negative: a non-Linux platform is explicitly unobservable (no /proc assumption)'
OBS_MODULE=/opt/node_modules/@sleep2agi/agent-node/src/runtime/opencode-host-shared-observer.ts bun -e '
  const { observeHostSharedServe } = await import(process.env.OBS_MODULE);
  const r = observeHostSharedServe("http://127.0.0.1:4096", { platform: "darwin" });
  if (r.ok || r.reason !== "unsupported_platform") { console.error("FAIL: " + JSON.stringify(r)); process.exit(1); }
  console.log("non-Linux -> " + r.reason);
'

echo 'PASS: host-shared OpenCode observation provider suite'
