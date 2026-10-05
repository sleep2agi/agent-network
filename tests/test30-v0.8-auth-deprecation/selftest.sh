#!/usr/bin/env bash
# test30 selftest — the "just published" install window, against a local fake registry (no network).
#   R  the OLD install line (`npm install -g <pkg>@preview` while the tarball 404s) fails → witnessed red
#   W  install_published during a 20 s window waits it out and installs the exact version
#   N  tarball never appears → install_published fails within its bound and is NOT silent
# Exits non-zero if any case fails.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/install-published.sh"
source "$HERE/../lib/safe-rm.sh"

PKG=@sleep2agi/agent-network
VER=9.9.9-selftest.1
PORT=${SELFTEST_PORT:-4873}
S=$(mktemp -d /tmp/t30self.XXXXXX)
PASS=0; FAIL=0
ok() { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

mkdir -p "$S/pkg/package/bin"
printf '{"name":"%s","version":"%s","bin":{"anet":"bin/anet.js"}}\n' "$PKG" "$VER" > "$S/pkg/package/package.json"
printf '#!/usr/bin/env node\nconsole.log("%s")\n' "$VER" > "$S/pkg/package/bin/anet.js"
chmod 0755 "$S/pkg/package/bin/anet.js"
tar -C "$S/pkg" -czf "$S/pkg.tgz" package

TGZ="$S/pkg.tgz" PKG="$PKG" VER="$VER" PORT="$PORT" bun "$HERE/fake-registry.ts" > "$S/registry.log" 2>&1 &
REG_PID=$!
trap 'kill $REG_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT/__window?ms=0" >/dev/null 2>&1 && break; sleep 0.2; done

fresh_env() { # isolated npm prefix + cache per case; registry = the fake one
  local d=$1
  mkdir -p "$d/prefix" "$d/cache"
  export npm_config_registry="http://127.0.0.1:$PORT/" npm_config_prefix="$d/prefix" npm_config_cache="$d/cache" \
    npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false npm_config_fetch_retries=0
}
window() { curl -fsS "http://127.0.0.1:$PORT/__window?ms=$1" >/dev/null; }

echo "[selftest] install window right after a publish (fake registry :$PORT)"

# R — what run.sh did before: one install of the moving tag, output hidden.
fresh_env "$S/r"; window 600000
rc=0; npm install -g "$PKG@preview" >"$S/r/npm.log" 2>&1 || rc=$?
if [ "$rc" != 0 ] && grep -Eq 'E404|404' "$S/r/npm.log"; then ok "R old install line is red inside the window (rc=$rc, $(grep -m1 -o 'E404' "$S/r/npm.log" || echo 404))"
else bad "R old install line did not fail inside the window (rc=$rc)"; sed 's/^/      /' "$S/r/npm.log" | tail -n 15; fi

# W — the fix: waits for the tarball, then installs the exact version.
fresh_env "$S/w"; window 20000
out=$(PUBLISH_WAIT_S=120 PUBLISH_POLL_S=3 install_published "$PKG" preview "$S/w/npm.log" 2>&1); rc=$?
echo "$out" | sed 's/^/      /'
got=$("$S/w/prefix/bin/anet" 2>/dev/null || true)
if [ "$rc" = 0 ] && [ "$got" = "$VER" ] && printf '%s' "$out" | grep -Fq "waiting:"; then ok "W waited out the window and installed $got"
else bad "W rc=$rc anet=$got"; tail -n 15 "$S/w/npm.log" | sed 's/^/      /'; fi

# N — never servable: bounded, and says why.
fresh_env "$S/n"; window -1
out=$(PUBLISH_WAIT_S=6 PUBLISH_POLL_S=2 install_published "$PKG" preview "$S/n/npm.log" 2>&1); rc=$?
echo "$out" | sed 's/^/      /'
if [ "$rc" != 0 ] && printf '%s' "$out" | grep -Fq "FAIL: $PKG@preview → $VER" && printf '%s' "$out" | grep -Fq -- "--- tail of"; then ok "N bounded failure with a FAIL line and the log tail"
else bad "N rc=$rc"; fi

safe_rm_rf "$S"
echo "selftest PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ] && [ "$PASS" = 3 ]
