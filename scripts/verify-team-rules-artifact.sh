#!/usr/bin/env bash
# Verify that the **published** agent-node artifact really injects the Hub team-rules
# managed block — the L2.5 rung of the evidence ladder (published binary + stub dependency).
#
# Why this exists: the first time this was checked, it was an ad-hoc sequence in a chat log:
# download the tarball, start a stub hub, run the real binary four ways, diff the file. The
# claims ("block written", "same revision is a no-op", "hub down keeps the file", "a broken
# marker is refused") were true, but nobody could re-run them. This is that sequence, as a
# script with assertions.
#
# What it proves:  the bytes on npm behave as documented, at the file level.
# What it does NOT prove: a real node's behaviour (registration, daemon, real runtime, real
# Hub). That last rung needs a node restart — see docs/rfcs/RFC-043 and board #993/#1521.
#
# Usage:
#   scripts/verify-team-rules-artifact.sh                    # newest preview on npm
#   scripts/verify-team-rules-artifact.sh 2.5.0-preview.156
#
# Exit: 0 = every assertion held; 1 = at least one did not (the failing line is printed).
# Read-only against npm; writes only inside a temp dir, which is removed on exit.
set -uo pipefail

PKG="@sleep2agi/agent-node"
VER="${1:-$(npm view "$PKG" dist-tags.preview 2>/dev/null | tr -d '[:space:]')}"
[ -n "$VER" ] || { echo "FAIL: cannot resolve a preview version for $PKG"; exit 1; }

PORT="${TEAM_RULES_STUB_PORT:-9399}"
WORK="$(mktemp -d /tmp/team-rules-artifact.XXXXXX)"
STUB_PID=""
cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; exit 1; }

echo "== artifact"
TB="$(npm view "$PKG@$VER" dist.tarball 2>/dev/null)"
[ -n "$TB" ] || fail "$PKG@$VER is not resolvable on npm"
curl -fsSL "$TB" -o "$WORK/pkg.tgz" || fail "cannot download $TB"
tar -C "$WORK" -xzf "$WORK/pkg.tgz" || fail "cannot extract tarball"
CLI="$WORK/package/dist/cli.js"
[ -f "$CLI" ] || fail "published tarball has no dist/cli.js"
grep -q "team-rules" "$CLI" || fail "published binary does not contain the injection path"
pass "downloaded $VER and found the injection path in dist/cli.js"

echo "== stub hub"
cat > "$WORK/stub.py" <<'PY'
import http.server, json, sys
RULES = {"ok": True, "rules": {"content": "# Hub team rules\n\n- read before writing\n", "revision": 3,
                                "updated_at": "2026-01-01T00:00:00Z"}}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(RULES).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
python3 "$WORK/stub.py" "$PORT" &
STUB_PID=$!
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/networks/net_x/rules" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "http://127.0.0.1:$PORT/api/networks/net_x/rules" >/dev/null || fail "stub hub did not start"
pass "stub hub listening on 127.0.0.1:$PORT"

echo "== fixture"
NODE_DIR="$WORK/node"
mkdir -p "$NODE_DIR"
printf '# my own rules\n\n- do not touch me\n' > "$NODE_DIR/AGENTS.md"
cp "$NODE_DIR/AGENTS.md" "$WORK/AGENTS.orig"
cat > "$NODE_DIR/config.json" <<JSON
{"hub":"http://127.0.0.1:$PORT","token":"ntok_artifact_test","network_id":"net_x",
 "node_id":"n_artifact_test","node_name":"artifact-test","runtime":"codex"}
JSON

run_node() { # prints only the decision line, not the warn line above it
  ( cd "$NODE_DIR" && ANET_TEAM_RULES=1 timeout 45 node "$CLI" --config config.json --alias artifact-test 2>&1 ) \
    | grep -oE "\[team-rules\] (injected|unchanged|skipped|error)[^[]*" | head -1
}

echo "== 1/4 first start injects the block"
OUT="$(run_node)"
case "$OUT" in *injected*) pass "injected: $(echo "$OUT" | head -c 60)";; *) fail "expected an injection, got: ${OUT:-<nothing>}";; esac
grep -q "<!-- ANET:TEAM-RULES v3 BEGIN" "$NODE_DIR/AGENTS.md" || fail "no BEGIN marker in AGENTS.md"
grep -q "<!-- ANET:TEAM-RULES v3 END -->"   "$NODE_DIR/AGENTS.md" || fail "no END marker in AGENTS.md"
grep -q "# Hub team rules"                  "$NODE_DIR/AGENTS.md" || fail "Hub rules body missing"
# the user's own lines must survive byte for byte
tail -n 3 "$NODE_DIR/AGENTS.md" | diff -q - "$WORK/AGENTS.orig" >/dev/null \
  || fail "the user's own content was not preserved at the end of the file"
pass "block written at the top; user content preserved"

echo "== 2/4 the same revision is a no-op"
cp "$NODE_DIR/AGENTS.md" "$WORK/AGENTS.after1"
OUT="$(run_node)"
case "$OUT" in *unchanged*) pass "unchanged: $(echo "$OUT" | head -c 60)";; *) fail "expected unchanged, got: ${OUT:-<nothing>}";; esac
cmp -s "$NODE_DIR/AGENTS.md" "$WORK/AGENTS.after1" || fail "the file changed on an unchanged revision"
pass "file is byte-identical after a second start"

echo "== 3/4 hub unreachable keeps the file"
kill "$STUB_PID" 2>/dev/null; STUB_PID=""; sleep 0.5
OUT="$(run_node)"
case "$OUT" in *hub_unreachable*) pass "skipped: $(echo "$OUT" | head -c 60)";; *) fail "expected hub_unreachable, got: ${OUT:-<nothing>}";; esac
cmp -s "$NODE_DIR/AGENTS.md" "$WORK/AGENTS.after1" || fail "the file changed while the hub was down"
pass "file untouched with the hub down (the block was not deleted)"

echo "== 4/4 a half-written marker is refused"
python3 - "$NODE_DIR/AGENTS.md" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read().replace("<!-- ANET:TEAM-RULES v3 END -->",
                                             "<!-- ANET:TEAM-RULES v3 END (broken) -->", 1)
open(p, "w", encoding="utf-8").write(s)
PY
cp "$NODE_DIR/AGENTS.md" "$WORK/AGENTS.broken"
python3 "$WORK/stub.py" "$PORT" & STUB_PID=$!
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/networks/net_x/rules" >/dev/null 2>&1 && break; sleep 0.25; done
OUT="$(run_node)"
case "$OUT" in *"expected exactly one BEGIN"*) pass "refused: $(echo "$OUT" | head -c 80)";; *) fail "expected a refusal, got: ${OUT:-<nothing>}";; esac
cmp -s "$NODE_DIR/AGENTS.md" "$WORK/AGENTS.broken" || fail "the file changed despite the refusal"
pass "file untouched after the refusal"

echo "== RESULT: PASS ($PKG@$VER)"
