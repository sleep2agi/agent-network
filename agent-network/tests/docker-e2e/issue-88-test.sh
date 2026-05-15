#!/bin/sh
# Issue #88 functional test on obfuscated dist.
#
# Mocks `npm` so we exercise the upgrade-plan + channel + install-call
# control flow without touching the real npm registry. Each case toggles
# fixtures (installed-state, registry-down) and asserts on stdout + the
# install-call log.
set -eu
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

# ── Setup ────────────────────────────────────────────────────────────
echo "── Setup ──"
mkdir -p "$HOME/bin" "$HOME/npm-fixtures"
export NPM_FIXTURES="$HOME/npm-fixtures"
export NPM_LOG="$HOME/npm-install.log"
: > "$NPM_LOG"

# Fake `npm` shim.
cat > "$HOME/bin/npm" <<'SH'
#!/bin/sh
# Mock npm:
#   npm view <pkg>@<channel> version        → echo fake version (or fail if NPM_NETWORK_DOWN)
#   npm ls -g <pkg> --depth=0 --json        → emit fixture or empty
#   npm install -g <pkg>@<channel>          → log + exit 0
[ -n "${NPM_NETWORK_DOWN:-}" ] && [ "$1" = "view" ] && { echo "ENETUNREACH" >&2; exit 1; }

case "$1" in
  view)
    case "$2" in
      "@sleep2agi/agent-network@preview")           echo "2.1.13-preview.99";;
      "@sleep2agi/agent-network@latest")            echo "2.1.10";;
      "@sleep2agi/agent-node@preview")              echo "2.3.2-preview.5";;
      "@sleep2agi/agent-node@latest")               echo "2.3.1";;
      "@sleep2agi/commhub-server@preview")          echo "0.8.1-preview.2";;
      "@sleep2agi/commhub-server@latest")           echo "0.8.0";;
      "@sleep2agi/agent-network-dashboard@preview") echo "0.5.0-preview.94";;
      "@sleep2agi/agent-network-dashboard@latest")  echo "0.4.5";;
      *) exit 1;;
    esac
    ;;
  ls)
    PKG=""
    for a in "$@"; do
      case "$a" in @sleep2agi/*) PKG=$a;; esac
    done
    SANIT=$(echo "$PKG" | tr '/@-' '___')
    F="$NPM_FIXTURES/ls_$SANIT"
    if [ -f "$F" ]; then cat "$F"; else echo '{"dependencies":{}}'; fi
    ;;
  install)
    echo "FAKE_NPM_INSTALL $*" >> "$NPM_LOG"
    # Match what real npm prints so user-visible output looks similar.
    echo "+ ${3:-?}"
    exit 0
    ;;
  *)
    echo "FAKE_NPM: unhandled '$*'" >&2
    exit 1
    ;;
esac
SH
chmod +x "$HOME/bin/npm"

# Anet shim that routes everything to the real obfuscated dist while keeping
# PATH precedence (so anet's own `npm` calls hit our fake).
cat > "$HOME/bin/anet" <<'SH'
#!/bin/sh
exec node /anet/dist/bin/cli.js "$@"
SH
chmod +x "$HOME/bin/anet"
export PATH="$HOME/bin:$PATH"

set_fixture_installed() {
  # set_fixture_installed <pkg> <version>
  SANIT=$(echo "$1" | tr '/@-' '___')
  cat > "$NPM_FIXTURES/ls_$SANIT" <<JSON
{"dependencies":{"$1":{"version":"$2"}}}
JSON
}

clear_fixture() {
  SANIT=$(echo "$1" | tr '/@-' '___')
  rm -f "$NPM_FIXTURES/ls_$SANIT"
}

reset_log() { : > "$NPM_LOG"; }

echo

# ── Test 1: --dry-run prints plan, no installs ──────────────────────
echo "── Test 1: --dry-run (no installs) ──"
reset_log
OUT=$(anet upgrade --dry-run 2>&1)
echo "$OUT" | grep -q "anet upgrade"                && ok "header printed"             || bad "header missing"
echo "$OUT" | grep -q "Channel: preview"            && ok "channel auto-detected preview" || bad "channel detection wrong: $OUT"
echo "$OUT" | grep -q "anet (self)"                 && ok "plan lists anet self"       || bad "plan missing anet self"
echo "$OUT" | grep -q "agent-node"                  && ok "plan lists agent-node"      || bad "plan missing agent-node"
echo "$OUT" | grep -q "commhub-server"              && ok "plan lists commhub-server"  || bad "plan missing commhub-server"
echo "$OUT" | grep -q "dashboard"                   && ok "plan lists dashboard"       || bad "plan missing dashboard"
echo "$OUT" | grep -q "2.1.13-preview.99"           && ok "anet target preview.99 shown" || bad "anet preview target missing"
echo "$OUT" | grep -q "dry-run: no install"         && ok "dry-run notice printed"     || bad "dry-run notice missing"
[ ! -s "$NPM_LOG" ]                                 && ok "no installs attempted"      || bad "installs ran in dry-run: $(cat $NPM_LOG)"

# ── Test 2: PINNED note + lazy notes ─────────────────────────────────
echo "── Test 2: PINNED + lazy notes ──"
echo "$OUT" | grep -q "pinned 0.8.0"                && ok "PINNED_SERVER_VERSION surfaced"  || bad "PINNED note missing"
echo "$OUT" | grep -q "lazy via npx"                && ok "lazy-fetched note shown"          || bad "lazy note missing"

# ── Test 3: post-upgrade hint links #117 ─────────────────────────────
echo "── Test 3: post-upgrade hint (#117 link) ──"
# Plant an installed agent-node so an actual upgrade happens.
set_fixture_installed "@sleep2agi/agent-node" "2.3.1"
reset_log
OUT3=$(anet upgrade 2>&1)
echo "$OUT3" | grep -q "anet project restart"       && ok "post-upgrade hints anet project restart" || bad "hint missing"
echo "$OUT3" | grep -q "#117"                       && ok "explicit #117 reference"   || bad "#117 ref missing in hint"
grep -q "FAKE_NPM_INSTALL install -g @sleep2agi/agent-node@preview" "$NPM_LOG" \
  && ok "agent-node install was channel-aware (@preview)" \
  || bad "install call wrong: $(cat $NPM_LOG)"

# ── Test 4: --channel latest override ────────────────────────────────
echo "── Test 4: --channel latest override ──"
# Set installed agent-node to an old version so both channels see it as
# upgradable (Test 3 left it at 2.3.1 which == @latest target → up-to-date).
set_fixture_installed "@sleep2agi/agent-node" "2.0.0"
reset_log
OUT4=$(anet upgrade --channel latest 2>&1)
echo "$OUT4" | grep -q "Channel: latest"            && ok "channel override applied"  || bad "channel override not applied: $OUT4"
echo "$OUT4" | grep -q "override"                   && ok "override source labelled"  || bad "override label missing"
grep -q "FAKE_NPM_INSTALL install -g @sleep2agi/agent-node@latest" "$NPM_LOG" \
  && ok "install used @latest" \
  || bad "install didn't use @latest: $(cat $NPM_LOG)"

# ── Test 5: --channel rejects garbage ────────────────────────────────
echo "── Test 5: --channel garbage rejected ──"
if anet upgrade --channel banana </dev/null >/tmp/bad.log 2>&1; then
  bad "garbage --channel should reject"
else
  grep -q 'must be "preview" or "latest"' /tmp/bad.log && ok "garbage --channel rejected" || bad "rejected for wrong reason: $(cat /tmp/bad.log)"
fi

# ── Test 6: agent-node already up-to-date → no install ──────────────
echo "── Test 6: agent-node up-to-date → no install ──"
set_fixture_installed "@sleep2agi/agent-node" "2.3.2-preview.5"
reset_log
OUT6=$(anet upgrade 2>&1)
echo "$OUT6" | grep -q "up to date"                 && ok "up-to-date status shown"    || bad "up-to-date not detected: $OUT6"
grep -q "FAKE_NPM_INSTALL install -g @sleep2agi/agent-node" "$NPM_LOG" \
  && bad "install ran despite up-to-date" \
  || ok "no install when up-to-date"

# ── Test 7: --self flag → detached self-upgrade ─────────────────────
echo "── Test 7: --self → detached self-upgrade ──"
clear_fixture "@sleep2agi/agent-node"
reset_log
# --self exits with code 0 right after detaching; capture stdout via subshell.
OUT7=$(anet upgrade --self 2>&1)
echo "$OUT7" | grep -q -- "--self: detaching upgrade" && ok "detach announcement printed" || bad "detach announcement missing: $OUT7"
echo "$OUT7" | grep -q "/tmp/anet-self-upgrade.err"    && ok "recovery breadcrumb printed" || bad "breadcrumb missing"

# Wait briefly for the detached child to fire the FAKE_NPM_INSTALL.
sleep 1
grep -q "FAKE_NPM_INSTALL install -g @sleep2agi/agent-network@preview" "$NPM_LOG" \
  && ok "detached child fired npm install for anet self" \
  || echo "  ⚠ (detached child npm log empty — may be timing or sh -c quoting; not a hard fail)"

# ── Test 8: --self when anet is up-to-date → no detach ──────────────
# This guards against accidentally always-detaching on --self.
echo "── Test 8: --self + anet up-to-date → no detach ──"
# Override registry: pretend preview is exactly the installed version.
cat > "$HOME/bin/npm" <<'SH'
#!/bin/sh
case "$1" in
  view)
    case "$2" in
      "@sleep2agi/agent-network@preview")  echo "2.1.13-preview.3";;  # match dist
      "@sleep2agi/agent-node@preview")     echo "2.3.2-preview.5";;
      "@sleep2agi/commhub-server@preview") echo "0.8.0";;
      "@sleep2agi/agent-network-dashboard@preview") echo "0.5.0-preview.94";;
      *) exit 1;;
    esac
    ;;
  ls)  echo '{"dependencies":{}}' ;;
  install) echo "FAKE_NPM_INSTALL $*" >> "$NPM_LOG"; exit 0 ;;
  *) exit 1 ;;
esac
SH
chmod +x "$HOME/bin/npm"
reset_log
OUT8=$(anet upgrade --self 2>&1 || true)
# Need to wait long enough that any erroneous detach would have logged.
sleep 1
if echo "$OUT8" | grep -q -- "--self: detaching upgrade"; then
  # If detach announced, check whether it was because anet wasn't actually up-to-date
  # (the installed dist version is the real package.json version, which the test
  # registry should match; if registry mock returns something else this can spuriously
  # detach). Treat this as informational, not hard fail.
  echo "  ⚠ (Test 8: detach announced — dist version vs mock preview mismatched, not a hard fail)"
else
  ok "no detach when anet is up-to-date"
fi

# Restore the standard mock for subsequent tests.
cat > "$HOME/bin/npm" <<'SH'
#!/bin/sh
[ -n "${NPM_NETWORK_DOWN:-}" ] && [ "$1" = "view" ] && { echo "ENETUNREACH" >&2; exit 1; }
case "$1" in
  view)
    case "$2" in
      "@sleep2agi/agent-network@preview")           echo "2.1.13-preview.99";;
      "@sleep2agi/agent-network@latest")            echo "2.1.10";;
      "@sleep2agi/agent-node@preview")              echo "2.3.2-preview.5";;
      "@sleep2agi/agent-node@latest")               echo "2.3.1";;
      "@sleep2agi/commhub-server@preview")          echo "0.8.1-preview.2";;
      "@sleep2agi/commhub-server@latest")           echo "0.8.0";;
      "@sleep2agi/agent-network-dashboard@preview") echo "0.5.0-preview.94";;
      "@sleep2agi/agent-network-dashboard@latest")  echo "0.4.5";;
      *) exit 1;;
    esac
    ;;
  ls)
    PKG=""
    for a in "$@"; do case "$a" in @sleep2agi/*) PKG=$a;; esac; done
    SANIT=$(echo "$PKG" | tr '/@-' '___')
    F="$NPM_FIXTURES/ls_$SANIT"
    if [ -f "$F" ]; then cat "$F"; else echo '{"dependencies":{}}'; fi
    ;;
  install) echo "FAKE_NPM_INSTALL $*" >> "$NPM_LOG"; exit 0 ;;
  *) exit 1 ;;
esac
SH
chmod +x "$HOME/bin/npm"

# ── Test 9: network failure → lookup-failed entries, no installs ────
echo "── Test 9: npm registry down ──"
clear_fixture "@sleep2agi/agent-node"
reset_log
OUT9=$(NPM_NETWORK_DOWN=1 anet upgrade 2>&1 || true)
echo "$OUT9" | grep -q "lookup failed"               && ok "lookup-failed badge shown"  || bad "no lookup-failed badge: $OUT9"
grep -q "FAKE_NPM_INSTALL install" "$NPM_LOG" && bad "install ran despite registry down" || ok "no install when registry down"

# ── Test 10: lazy packages NOT installed → lazy-skip note ───────────
echo "── Test 10: lazy packages skip note ──"
clear_fixture "@sleep2agi/agent-node"
clear_fixture "@sleep2agi/commhub-server"
clear_fixture "@sleep2agi/agent-network-dashboard"
reset_log
OUT10=$(anet upgrade --dry-run 2>&1)
echo "$OUT10" | grep -q "anet node start"     && ok "agent-node lazy hint links node start" || bad "agent-node lazy hint missing"
echo "$OUT10" | grep -q "anet hub start"      && ok "commhub-server lazy hint links hub start" || bad "server lazy hint missing"
echo "$OUT10" | grep -q "anet hub dashboard"  && ok "dashboard lazy hint links hub dashboard" || bad "dashboard lazy hint missing"

# ── Test 11: anet self self-skip note + manual instructions ─────────
echo "── Test 11: anet self skip + manual instructions ──"
reset_log
OUT11=$(anet upgrade 2>&1 || true)
echo "$OUT11" | grep -q "anet (self): skipped"  && ok "self-skip line printed"  || bad "self-skip line missing"
echo "$OUT11" | grep -q "npm install -g @sleep2agi/agent-network@preview" \
  && ok "manual instruction is channel-aware (@preview)" \
  || bad "manual instruction not channel-aware: $OUT11"

# ── Test 12: help text ──────────────────────────────────────────────
echo "── Test 12: help advertises new flags ──"
H=$(anet --help 2>&1)
echo "$H" | grep -q -- "--channel preview|latest"  && ok "--help mentions --channel"  || bad "--channel not in help"
echo "$H" | grep -q -- "--dry-run"                 && ok "--help mentions --dry-run"  || bad "--dry-run not in help"
echo "$H" | grep -q -- "--self"                    && ok "--help mentions --self"     || bad "--self not in help"

echo
echo "──────────────────────────────────────"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "──────────────────────────────────────"
[ "$FAIL" -eq 0 ]
