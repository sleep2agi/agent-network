#!/bin/bash
set -u

PASS=0
FAIL=0
ANET="bun /app/agent-network/bin/cli.ts"
REPORT="/app/docs/tests/report-test226.txt"
ROOT="/tmp/test226"
WEB="$ROOT/web"
PORT=8126
URL="http://127.0.0.1:${PORT}/skillhub/catalog.json"

mkdir -p /app/docs/tests "$WEB/skillhub/skills/demo-skill/1.0.0" "$ROOT/home"
: >"$REPORT"

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); echo "PASS: $1" >>"$REPORT"; }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); echo "FAIL: $1" >>"$REPORT"; }
section() { echo ""; echo "$1"; echo "" >>"$REPORT"; echo "## $1" >>"$REPORT"; }

sha256_text() {
  python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'
}

write_catalog() {
  local hash="$1"
  cat >"$WEB/skillhub/catalog.json" <<EOF
{
  "schema_version": 1,
  "skills": [
    {
      "slug": "demo-skill",
      "name": "Demo Skill",
      "description": "Fixture skill for anet skill commands.",
      "version": "1.0.0",
      "content_sha256": "${hash}",
      "content_url": "/skillhub/skills/demo-skill/1.0.0/SKILL.md"
    }
  ]
}
EOF
}

echo "# Test 226 SkillHub CLI" >"$REPORT"
echo "- Runs in Docker from source." >>"$REPORT"
echo "- Catalog URL: $URL" >>"$REPORT"
echo "- Cache path: /tmp/test226/home/.anet/skillhub/catalog-cache.json" >>"$REPORT"
echo "" >>"$REPORT"

printf '# Demo Skill\n\nUse this fixture.\n' >"$WEB/skillhub/skills/demo-skill/1.0.0/SKILL.md"
GOOD_HASH=$(sha256_text <"$WEB/skillhub/skills/demo-skill/1.0.0/SKILL.md")
BAD_HASH="0000000000000000000000000000000000000000000000000000000000000000"
write_catalog "$GOOD_HASH"

pushd "$WEB" >/dev/null
python3 -m http.server "$PORT" >/tmp/test226-http.log 2>&1 &
SERVER_PID=$!
popd >/dev/null
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
sleep 1

section "1. Online list writes cache and shows cache path under --verbose"
OUT=$(HOME="$ROOT/home" ANET_SKILL_CATALOG_URL="$URL" $ANET skill list --verbose 2>&1)
echo "$OUT" >>"$REPORT"
echo "$OUT" | grep -q "demo-skill" && pass "skill list shows slug" || fail "skill list missing slug"
echo "$OUT" | grep -q "Demo Skill" && pass "skill list shows name" || fail "skill list missing name"
echo "$OUT" | grep -q "$ROOT/home/.anet/skillhub/catalog-cache.json" && pass "verbose output shows cache path" || fail "cache path not visible"
[ -f "$ROOT/home/.anet/skillhub/catalog-cache.json" ] && pass "catalog cache written" || fail "catalog cache missing"

section "2. Online show verifies sha256 and prints SKILL.md"
OUT=$(HOME="$ROOT/home" ANET_SKILL_CATALOG_URL="$URL" $ANET skill show demo-skill --verbose 2>&1)
echo "$OUT" >>"$REPORT"
echo "$OUT" | grep -q "# Demo Skill" && pass "skill show prints content" || fail "skill show missing content"
echo "$OUT" | grep -q "Verified sha256" && pass "skill show reports verification under verbose" || fail "verification line missing"

section "3. Offline list uses cache with time, source URL, and path"
kill "$SERVER_PID" 2>/dev/null || true
sleep 1
OUT=$(HOME="$ROOT/home" ANET_SKILL_CATALOG_URL="$URL" $ANET skill list 2>&1)
echo "$OUT" >>"$REPORT"
echo "$OUT" | grep -q "Using local SkillHub cache" && pass "offline cache use is explicit" || fail "offline cache message missing"
echo "$OUT" | grep -q "Cache time:" && pass "offline cache time printed" || fail "offline cache time missing"
echo "$OUT" | grep -q "Cache source: $URL" && pass "offline cache source printed" || fail "offline cache source missing"
echo "$OUT" | grep -q "$ROOT/home/.anet/skillhub/catalog-cache.json" && pass "offline cache path printed" || fail "offline cache path missing"

section "4. Offline without cache names failed URL"
OUT=$(HOME="$ROOT/no-cache-home" ANET_SKILL_CATALOG_URL="$URL" $ANET skill list 2>&1 || true)
echo "$OUT" >>"$REPORT"
echo "$OUT" | grep -q "Cannot read $URL" && pass "offline no-cache error names URL" || fail "offline no-cache URL missing"
echo "$OUT" | grep -q "no local cache" && pass "offline no-cache error is clear" || fail "offline no-cache reason missing"

section "5. Witnessed-red: same bad fixture accepted without verification, rejected by anet"
pushd "$WEB" >/dev/null
python3 -m http.server "$PORT" >/tmp/test226-http-2.log 2>&1 &
SERVER_PID=$!
popd >/dev/null
sleep 1
write_catalog "$BAD_HASH"

WITNESS_MODE=no_verify
if [ "$WITNESS_MODE" = "no_verify" ]; then
  OUT=$(curl -s "http://127.0.0.1:${PORT}/skillhub/skills/demo-skill/1.0.0/SKILL.md" || true)
  echo "$OUT" >>"$REPORT"
  echo "$OUT" | grep -q "# Demo Skill" && pass "witness baseline: bad content accepted when sha256 is not checked" || fail "witness baseline failed"
fi

WITNESS_MODE=verify
OUT=$(HOME="$ROOT/bad-home" ANET_SKILL_CATALOG_URL="$URL" $ANET skill show demo-skill 2>&1 || true)
echo "$OUT" >>"$REPORT"
echo "$OUT" | grep -q "sha256 mismatch" && pass "witness red: anet rejects mismatched sha256" || fail "anet did not reject mismatched sha256"
echo "$OUT" | grep -q "# Demo Skill" && fail "mismatched skill content leaked to stdout" || pass "mismatched content was not printed"

{
  echo ""
  echo "## Summary"
  echo "- Results: $PASS passed, $FAIL failed"
} >>"$REPORT"

cat "$REPORT"
echo ""
echo "═══════════════════════════════════"
echo "  Test 226 Result: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
