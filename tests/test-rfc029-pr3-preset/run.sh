#!/usr/bin/env bash
set -euo pipefail

REPORT_DIR="${REPORT_DIR:-/report}"
REPORT="$REPORT_DIR/pr3-smoke.txt"
mkdir -p "$REPORT_DIR"

: > "$REPORT"
{
  echo "# RFC-029 PR③ — preset + upgrade-pin smoke"
  echo
  echo "date: $(date -Iseconds)"
  echo "bun:  $(bun --version)"
  echo "node: $(node --version)"
  echo
} >> "$REPORT"

fail=0
step() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "  ✓ $label: $got (expected $want)" >> "$REPORT"
  else
    echo "  ✗ $label: $got (expected $want)" >> "$REPORT"
    fail=1
  fi
}

# ── S1: unit ────────────────────────────────────────────────────
{
  echo "## S1 — unit tests"
  echo
  echo '```'
  cd /repo/agent-network && bun test src/opencode-pin.test.ts src/opencode-preset.test.ts 2>&1 | tail -5
  echo '```'
  echo
} >> "$REPORT"

# ── S2: create wizard non-interactive with runtime + preset ──
export HOME=/tmp/anethome-s2
export ANTHROPIC_API_KEY="sk-smoke-anthropic-example-key"
mkdir -p "$HOME/.anet"
rm -rf /tmp/pr3-node-workdir

{
  echo "## S2 — auth.json / opencode.json materialization"
  echo
  echo '```'
  cd /repo/agent-network && bun -e '
    const { findOpencodePreset, writeOpencodeAuthJson, writeOpencodeConfigJson, readPresetKeyFromEnv } =
      await import("./src/opencode-preset");
    const preset = findOpencodePreset("anthropic");
    const key = readPresetKeyFromEnv(preset, process.env);
    const workDir = "/tmp/pr3-node-workdir";
    require("fs").mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const authPath = writeOpencodeAuthJson(workDir, preset, key);
    const cfgPath = writeOpencodeConfigJson(workDir, preset);
    console.log("auth=" + authPath);
    console.log("cfg=" + cfgPath);
    console.log("authMode=" + (require("fs").statSync(authPath).mode & 0o777).toString(8));
  '
  echo '```'
  echo
} >> "$REPORT"

AUTH_PATH="/tmp/pr3-node-workdir/.local/share/opencode/auth.json"
if [[ -f "$AUTH_PATH" ]]; then
  step "S2 auth.json exists" "yes" "yes"
  MODE=$(stat -c %a "$AUTH_PATH")
  step "S2 auth.json mode" "$MODE" "600"
  step "S2 auth.json contains the expected synthetic key" \
    "$(jq -e '.anthropic.key == "sk-smoke-anthropic-example-key"' "$AUTH_PATH" >/dev/null && echo yes || echo no)" "yes"
else
  step "S2 auth.json exists" "no" "yes"
fi

# ── S3: read-denylist pattern for auth.json ─────────────────────
{
  echo
  echo "## S3 — auth.json denylist regex"
  echo
  echo '```'
  grep -n "opencode/auth.json" /repo/agent-node/src/feishu-tool-deny.ts | head -3
  echo '```'
  echo
} >> "$REPORT"

if grep -q 'opencode\\/auth\\.json' /repo/agent-node/src/feishu-tool-deny.ts; then
  step "S3 denylist regex present" "yes" "yes"
else
  step "S3 denylist regex present" "no" "yes"
fi

# ── S4: unvetted upgrade-pin fails before npm or pin write ─────────
S4_FAKE_BIN=/tmp/pr3-fake-bin
S4_NPM_SENTINEL=/tmp/pr3-npm-called
S4_LOG=/tmp/pr3-upgrade-pin.log
rm -rf "$S4_FAKE_BIN"
rm -f "$S4_NPM_SENTINEL" "$S4_LOG" "$HOME/.anet/opencode-pin.json"
mkdir -p "$S4_FAKE_BIN"
cat > "$S4_FAKE_BIN/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
printf '%s\n' "$*" > /tmp/pr3-npm-called
exit 91
FAKE_NPM
chmod 755 "$S4_FAKE_BIN/npm"

set +e
(
  cd /repo/agent-network
  PATH="$S4_FAKE_BIN:$PATH" timeout 60 bun run bin/cli.ts opencode upgrade-pin 99.99.99
) > "$S4_LOG" 2>&1
S4_RC=$?
set -e

{
  echo
  echo "## S4 — unvetted upgrade-pin is rejected before npm"
  echo
  echo '```'
  head -20 "$S4_LOG"
  echo "exit=$S4_RC"
  echo '```'
  echo
} >> "$REPORT"

step "S4 unvetted pin exits nonzero" \
  "$([[ "$S4_RC" -ne 0 ]] && echo yes || echo no)" "yes"

step "S4 vetted-only refusal emitted" \
  "$(grep -Fq 'Refusing opencode-ai@99.99.99: this preview is vetted only for opencode-ai@1.18.1' "$S4_LOG" && echo yes || echo no)" "yes"

if [[ ! -e "$S4_NPM_SENTINEL" ]]; then
  step "S4 npm was NOT invoked" "no" "no"
else
  step "S4 npm was NOT invoked" "yes" "no"
fi

if [[ ! -f "$HOME/.anet/opencode-pin.json" ]]; then
  step "S4 pin file NOT created on refusal" "no" "no"
else
  step "S4 pin file NOT created on refusal" "yes" "no"
fi

# ── S5: existing denylist entries preserved ─────────────────────
# Count actual regex entries (start with `  /^\` or `  /`) — filter
# out comment-only lines and the ] terminator.
DENY_COUNT=$(grep -cE '^  /[^/]' /repo/agent-node/src/feishu-tool-deny.ts || true)
if [[ "$DENY_COUNT" -ge 9 ]]; then
  echo "  ✓ S5 denylist entry count: $DENY_COUNT (expected >=9)" >> "$REPORT"
else
  echo "  ✗ S5 denylist entry count too low: $DENY_COUNT (expected >=9)" >> "$REPORT"
  fail=1
fi

echo >> "$REPORT"
if [[ "$fail" -eq 0 ]]; then
  echo "OVERALL: PASS" >> "$REPORT"
else
  echo "OVERALL: FAIL — see above" >> "$REPORT"
fi

cat "$REPORT"
exit "$fail"
