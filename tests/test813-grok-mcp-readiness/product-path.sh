#!/usr/bin/env bash
set -euo pipefail
source tests/lib/safe-rm.sh

mode=${1:-all}
case "$mode" in
  all|negative|recovery) ;;
  *) echo "FAIL: unknown product-path mode: $mode" >&2; exit 1 ;;
esac

root=$(mktemp -d /tmp/test813-product.XXXXXX)
chmod 700 "$root"
cleanup() { safe_rm_rf "$root"; }
trap cleanup EXIT

home="$root/home"
work="$root/work"
config="$root/config.json"
mkdir -p "$home/.grok" "$work/.anet"
chmod 700 "$home" "$home/.grok" "$work"
cp tests/test813-grok-mcp-readiness/fake-grok.mjs "$root/grok"
chmod 700 "$root/grok"

cat >"$config" <<'JSON'
{"runtime":"grok-build-cli","grokCopresence":true,"hub":"http://127.0.0.1:9","token":"fixture-token","grokCliSession":"11111111-1111-4111-8111-111111111813","flags":{}}
JSON
chmod 600 "$config"

(cd agent-node && bun run build >/dev/null)
(cd "$work" && bun build /workspace/agent-network/src/node-server.ts \
  --target bun --outfile .anet/node-server.js >/dev/null)
chmod 700 "$work/.anet/node-server.js"
printf '%s\n' \
  'COMMHUB_URL=http://127.0.0.1:9' \
  'COMMHUB_TOKEN=fixture-token' >"$work/.anet/.env"
chmod 600 "$work/.anet/.env"

run_agent() {
  local path=$1 bun_bin=$2 log=$3
  set +e
  (
    cd "$work"
    timeout 15s env -i \
      HOME="$home" PATH="$path" BUN_BIN="$bun_bin" GROK_BINARY="$root/grok" \
      /usr/local/bin/node /workspace/agent-node/dist/cli.js \
      --config "$config" --alias test813-dog --runtime grok-build-cli
  ) >"$log" 2>&1
  local rc=$?
  set -e
  [ "$rc" -ne 0 ] || { echo "FAIL: product-path process unexpectedly stayed successful" >&2; return 1; }
}

stop_fake_leaders() {
  local proc pid
  local -a argv=()
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    argv=()
    mapfile -d '' -t argv <"$proc/cmdline" || true
    [ "${#argv[@]}" -ge 4 ] || continue
    if [ "${argv[1]}" = "$root/grok" ] \
      && [ "${argv[2]}" = agent ] && [ "${argv[3]}" = leader ]; then
      pid=${proc##*/}
      kill -TERM "$pid"
      for _ in $(seq 1 50); do
        [ ! -e "$proc" ] && break
        sleep 0.02
      done
      [ ! -e "$proc" ] || { echo "FAIL: fake Grok Leader $pid did not stop" >&2; exit 1; }
    fi
  done
  find "$home/.anet-grok" -type s \( -name 'leader.sock' -o -name 'attach.sock' \) -delete
}

if [ "$mode" = all ] || [ "$mode" = negative ]; then
  before=$(sha256sum "$config" | cut -d' ' -f1)
  run_agent /usr/bin:/bin /definitely/missing/bun "$root/negative.log"
  grep -Fxq 'Error: grok copresence CommHub MCP command could not be resolved or executed' "$root/negative.log" || {
    echo "NEGATIVE_RUNTIME_GATE_NOT_REACHED" >&2
    sed -n '1,100p' "$root/negative.log" >&2
    exit 1
  }
  ! grep -Eq '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] \[INFO \] \[test813-dog\] 已注册到 CommHub$' "$root/negative.log" || {
    echo "FAIL: missing-Bun product path registered before its runtime gate" >&2
    exit 1
  }
  after=$(sha256sum "$config" | cut -d' ' -f1)
  [ "$before" = "$after" ] || {
    echo "FAIL: missing-Bun product path changed the persisted session config" >&2
    exit 1
  }
  echo "PRODUCT_PATH_NEGATIVE_PASS registration=absent session=unchanged"
fi

if [ "$mode" = all ] || [ "$mode" = recovery ]; then
  node -e 'const fs=require("fs");const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p));delete c.grokCliSession;fs.writeFileSync(p,JSON.stringify(c)+"\n",{mode:0o600})' "$config"
  run_agent /usr/local/bin:/usr/bin:/bin /usr/local/bin/bun "$root/first.log"
  grep -Eq '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] \[INFO \] \[test813-dog\] \[grok-copresence\] TUI ready session=[0-9a-f]{8} attach=/.+$' "$root/first.log" || {
    echo "FAIL: canonical-Bun product path did not reach TUI readiness" >&2
    sed -n '1,120p' "$root/first.log" >&2
    exit 1
  }
  grep -Eq '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] \[INFO \] \[test813-dog\] \[grok-copresence\] grok 0\.2\.93 \(f00f96316d\); attach with anet grok attach test813-dog$' "$root/first.log" || {
    echo "FAIL: canonical-Bun product path did not complete the real doctor/startup boundary" >&2
    exit 1
  }
  sid1=$(node -e 'const fs=require("fs");console.log(JSON.parse(fs.readFileSync(process.argv[1])).grokCliSession||"")' "$config")
  [[ "$sid1" =~ ^[0-9a-f-]{36}$ ]] || { echo "FAIL: first product start did not persist a Grok session" >&2; exit 1; }
  stop_fake_leaders

  # The reviewed fake reproduces native Grok's temporary read-only sandbox
  # placeholders. A real launcher stop removes them; this probe deliberately
  # terminates at the unreachable Hub registration boundary, so verify their
  # exact harmless tuple before performing that launcher-owned cleanup.
  for name in .grok .claude .cursor .mcp.json .envrc; do
    placeholder="$work/$name"
    [ -f "$placeholder" ] && [ ! -L "$placeholder" ] \
      && [ ! -s "$placeholder" ] && [ "$(stat -c %a "$placeholder")" = 444 ] || {
        echo "FAIL: fake Grok sandbox placeholder tuple changed: $name" >&2
        exit 1
      }
    chmod 600 "$placeholder"
    rm -f -- "$placeholder"
  done

  run_agent /usr/local/bin:/usr/bin:/bin /usr/local/bin/bun "$root/second.log"
  grep -Eq '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] \[INFO \] \[test813-dog\] \[grok-copresence\] TUI ready session=[0-9a-f]{8} attach=/.+$' "$root/second.log" || {
    echo "FAIL: product recovery did not return to TUI readiness" >&2
    sed -n '1,120p' "$root/second.log" >&2
    exit 1
  }
  sid2=$(node -e 'const fs=require("fs");console.log(JSON.parse(fs.readFileSync(process.argv[1])).grokCliSession||"")' "$config")
  [ "$sid1" = "$sid2" ] || { echo "FAIL: product recovery replaced the existing Grok session" >&2; exit 1; }
  stop_fake_leaders
  echo "PRODUCT_PATH_RECOVERY_PASS session=preserved"
fi
