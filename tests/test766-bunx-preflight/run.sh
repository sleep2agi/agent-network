#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/repo
ART=/artifacts
PASS=0
FAIL=0
mkdir -p "$ART"
source "$ROOT/tests/lib/safe-rm.sh"

ok(){ PASS=$((PASS+1)); printf 'PASS %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$*"; }

probe_bun_only(){
  local case_root home log rc
  case_root=$(mktemp -d /tmp/test766-bun-only.XXXXXX)
  home="$case_root/home"
  log="$case_root/cli.log"
  mkdir -p "$home"
  set +e
  HOME="$home" PATH="$ROOT/tests/test766-bunx-preflight/fake-bun-only:/usr/bin:/bin" \
    /usr/local/bin/bun "$ROOT/agent-network/bin/cli.ts" hub start \
      --host 127.0.0.1 --port 27668 --username admin --password StrongPassw0rd \
      >"$log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]] \
    || ! grep -Fq '找到了 bun,但没有 bunx' "$log" \
    || ! grep -Fq 'ln -s "$(command -v bun)"' "$log" \
    || grep -Fq 'Starting CommHub Server' "$log"; then
    cat "$log" >&2
    safe_rm_rf "$case_root"
    return 1
  fi
  safe_rm_rf "$case_root"
}

probe_neither(){
  local case_root home log rc
  case_root=$(mktemp -d /tmp/test766-neither.XXXXXX)
  home="$case_root/home"
  log="$case_root/cli.log"
  mkdir -p "$home"
  set +e
  HOME="$home" PATH="/usr/bin:/bin" \
    /usr/local/bin/bun "$ROOT/agent-network/bin/cli.ts" hub start \
      --host 127.0.0.1 --port 27668 --username admin --password StrongPassw0rd \
      >"$log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]] \
    || ! grep -Fq 'anet hub start requires the Bun runtime' "$log" \
    || grep -Fq '找到了 bun,但没有 bunx' "$log" \
    || grep -Fq 'Starting CommHub Server' "$log"; then
    cat "$log" >&2
    safe_rm_rf "$case_root"
    return 1
  fi
  safe_rm_rf "$case_root"
}

probe_bunx(){
  local case_root home capture log cli_pid fixture_pid rc
  case_root=$(mktemp -d /tmp/test766-bunx.XXXXXX)
  home="$case_root/home"
  capture="$case_root/runner.argv"
  log="$case_root/cli.log"
  mkdir -p "$home"

  HOME="$home" TEST766_CAPTURE="$capture" \
    PATH="$ROOT/tests/test766-bunx-preflight/fake-bunx:/usr/bin:/bin" \
    /usr/local/bin/bun "$ROOT/agent-network/bin/cli.ts" hub start \
      --host 127.0.0.1 --port 27668 --username admin --password StrongPassw0rd \
      >"$log" 2>&1 &
  cli_pid=$!

  for _ in $(seq 1 100); do
    [[ -s "$capture" ]] \
      && grep -Fq 'Server running on http://127.0.0.1:27668' "$log" \
      && break
    sleep 0.05
  done

  rc=0
  [[ -s "$capture" ]] || rc=1
  [[ "$(sed -n '1p' "$capture" 2>/dev/null || true)" == "--bun" ]] || rc=1
  grep -Fxq '@sleep2agi/commhub-server@0.9.0-preview.29' "$capture" || rc=1
  grep -Fq 'Server running on http://127.0.0.1:27668' "$log" || rc=1

  kill "$cli_pid" 2>/dev/null || true
  fixture_pid=$(cat "$capture.pid" 2>/dev/null || true)
  [[ -n "$fixture_pid" ]] && kill "$fixture_pid" 2>/dev/null || true
  wait "$cli_pid" 2>/dev/null || true
  if [[ "$rc" -ne 0 ]]; then
    cat "$log" >&2 || true
    sed -n '1,20p' "$capture" >&2 || true
    safe_rm_rf "$case_root"
    return 1
  fi
  safe_rm_rf "$case_root"
}

probe_all(){
  probe_bun_only
  probe_neither
  probe_bunx
}

expect_red(){
  local name="$1"; shift
  if "$@" >"$ART/$name.log" 2>&1; then
    bad "mutation $name survived"
  else
    tail -50 "$ART/$name.log"
    ok "mutation $name witnessed red at its named behavior"
  fi
}

printf 'source_commit=%s\n' "${TEST766_SOURCE_COMMIT:-unknown}"
cd "$ROOT"

probe_all
ok "bun-only, neither, and bunx behavior matrix"
(cd agent-network && bun run build)
ok "agent-network production build"

cp agent-network/bin/cli.ts /tmp/test766-cli.orig

[[ "$(grep -Fc 'if (!commandExists("bunx")) {' agent-network/bin/cli.ts)" -eq 1 ]]
sed -i 's/if (!commandExists("bunx")) {/if (!commandExists("bunx") \&\& !commandExists("bun")) {/' agent-network/bin/cli.ts
grep -Fq 'if (!commandExists("bunx") && !commandExists("bun")) {' agent-network/bin/cli.ts
expect_red old-or-allows-bun-only probe_bun_only
cp /tmp/test766-cli.orig agent-network/bin/cli.ts

[[ "$(grep -Fc 'if (!commandExists("bunx")) {' agent-network/bin/cli.ts)" -eq 1 ]]
sed -i 's/if (!commandExists("bunx")) {/if (true || !commandExists("bunx")) {/' agent-network/bin/cli.ts
grep -Fq 'if (true || !commandExists("bunx")) {' agent-network/bin/cli.ts
expect_red valid-bunx-blocked probe_bunx
cp /tmp/test766-cli.orig agent-network/bin/cli.ts

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
