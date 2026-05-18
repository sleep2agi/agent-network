#!/usr/bin/env bash
# Grok Build capability probe for Agent Network runtime integration.
set -euo pipefail

REPORT_PATH="${REPORT_PATH:-/work/docs/tests/report-grok-build-capability.md}"
FIXTURE_DIR="${FIXTURE_DIR:-/work/docs/tests/fixtures/grok-build}"
WORK_ROOT="${WORK_ROOT:-/tmp/grok-build-probe}"
TIMEOUT_BIN="${TIMEOUT_BIN:-timeout}"
GROK_INSTALL_URL="${GROK_INSTALL_URL:-https://x.ai/cli/install.sh}"

PASS=0
FAIL=0
SKIP=0
WARN=0
DETAILS=""
VERDICT="Wait"
GROK_VERSION="not checked"

mkdir -p "$(dirname "$REPORT_PATH")" "$FIXTURE_DIR" "$WORK_ROOT"
export HOME="${HOME:-/tmp/grok-home}"
mkdir -p "$HOME"
export PATH="$HOME/.local/bin:$HOME/.grok/bin:$HOME/bin:/root/.local/bin:/root/.grok/bin:/root/bin:$PATH"

append_detail() {
  DETAILS="${DETAILS}
| $1 | $2 | $3 |"
}

pass() {
  PASS=$((PASS + 1))
  echo "PASS: $1"
  append_detail "$1" "PASS" "$2"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "FAIL: $1 - $2"
  append_detail "$1" "FAIL" "$2"
}

skip() {
  SKIP=$((SKIP + 1))
  echo "SKIP: $1 - $2"
  append_detail "$1" "SKIP" "$2"
}

warn() {
  WARN=$((WARN + 1))
  echo "WARN: $1 - $2"
  append_detail "$1" "WARN" "$2"
}

run_capture() {
  local label="$1"
  local seconds="$2"
  local outfile="$3"
  shift 3
  set +e
  "$TIMEOUT_BIN" "$seconds" "$@" >"$outfile" 2>"$outfile.stderr"
  local status=$?
  set -e
  echo "$status"
}

write_report() {
  local generated_at
  generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if [[ "$FAIL" -gt 0 ]]; then
    VERDICT="No-go"
  elif [[ "$SKIP" -gt 0 || "$WARN" -gt 0 ]]; then
    VERDICT="Wait"
  elif [[ -s "$FIXTURE_DIR/acp-stdio.jsonl" ]]; then
    VERDICT="ACP Go"
  elif [[ -s "$FIXTURE_DIR/streaming-json.jsonl" ]]; then
    VERDICT="CLI fallback"
  else
    VERDICT="Wait"
  fi

  cat >"$REPORT_PATH" <<EOF_REPORT
# Grok Build Capability Probe

Date: $generated_at
Suite: tests/test-grok-build-capability
Runtime target: grok-build-acp / grok-build-cli
Verdict: **$VERDICT**

## Summary

- PASS: $PASS
- FAIL: $FAIL
- SKIP: $SKIP
- WARN: $WARN
- grok version: \`$GROK_VERSION\`
- Credential: \`GROK_CODE_XAI_API_KEY\` $([[ -n "${GROK_CODE_XAI_API_KEY:-}" ]] && echo "present" || echo "missing")

## Results

| Probe | Status | Detail |
|---|---|---|
$DETAILS

## Fixtures

- streaming JSON: \`docs/tests/fixtures/grok-build/streaming-json.jsonl\`
- JSON final: \`docs/tests/fixtures/grok-build/final.json\`
- ACP stdio: \`docs/tests/fixtures/grok-build/acp-stdio.jsonl\`
- MCP no-op: \`docs/tests/fixtures/grok-build/mcp-noop.jsonl\`

## Notes

- This suite installs Grok Build inside Docker using the official installer URL: \`$GROK_INSTALL_URL\`.
- If \`GROK_CODE_XAI_API_KEY\` is absent, authenticated probes are skipped and the verdict remains Wait.
- The probe does not enable \`--always-approve\` by default. Permission behavior is inspected separately.
EOF_REPORT
}

trap write_report EXIT

echo "[0] install/check grok"
if ! command -v grok >/dev/null 2>&1; then
  INSTALL_LOG="$WORK_ROOT/install.log"
  set +e
  curl -fsSL "$GROK_INSTALL_URL" | bash >"$INSTALL_LOG" 2>&1
  INSTALL_STATUS=$?
  set -e
  if [[ "$INSTALL_STATUS" -ne 0 ]]; then
    warn "grok install" "installer failed with status $INSTALL_STATUS; see container log $INSTALL_LOG"
  fi
fi

if command -v grok >/dev/null 2>&1; then
  VERSION_OUT="$WORK_ROOT/version.txt"
  VERSION_STATUS="$(run_capture "grok version" 20 "$VERSION_OUT" grok --version)"
  if [[ "$VERSION_STATUS" -eq 0 ]]; then
    GROK_VERSION="$(tr '\n' ' ' <"$VERSION_OUT" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
    pass "grok --version" "$GROK_VERSION"
  else
    fail "grok --version" "exit=$VERSION_STATUS stderr=$(tail -5 "$VERSION_OUT.stderr" | tr '\n' ' ')"
  fi
else
  warn "grok executable" "not found after installer"
fi

if command -v grok >/dev/null 2>&1; then
  echo "[1] permission default"
  HELP_OUT="$WORK_ROOT/help.txt"
  run_capture "grok help" 20 "$HELP_OUT" grok --help >/dev/null || true
  if grep -q -- "--always-approve" "$HELP_OUT" || grep -q -- "--always-approve" "$HELP_OUT.stderr"; then
    pass "permission default" "--always-approve is explicit; probe did not enable it"
  else
    warn "permission default" "could not confirm --always-approve flag from help output"
  fi
else
  skip "permission default" "grok executable unavailable"
fi

if [[ -z "${GROK_CODE_XAI_API_KEY:-}" ]]; then
  skip "API-key-only headless" "GROK_CODE_XAI_API_KEY not provided"
  skip "grok -p final answer" "requires GROK_CODE_XAI_API_KEY"
  skip "streaming-json schema" "requires GROK_CODE_XAI_API_KEY"
  skip "session resume" "requires GROK_CODE_XAI_API_KEY"
  skip "temp repo file edit" "requires GROK_CODE_XAI_API_KEY"
  skip "ACP stdio" "requires GROK_CODE_XAI_API_KEY"
  skip "MCP no-op tool" "requires GROK_CODE_XAI_API_KEY"
  exit 0
fi

if ! command -v grok >/dev/null 2>&1; then
  fail "authenticated probes" "grok executable unavailable"
  exit 1
fi

echo "[2] prepare temp repo"
REPO="$WORK_ROOT/repo"
rm -rf "$REPO"
mkdir -p "$REPO"
git -C "$REPO" init >/dev/null
cat >"$REPO/README.md" <<'EOF_README'
# Grok Probe Repo

This repository is used only for runtime capability probing.
EOF_README
cat >"$REPO/probe.txt" <<'EOF_PROBE'
before
EOF_PROBE

echo "[3] headless final answer"
FINAL_TXT="$WORK_ROOT/final.txt"
FINAL_STATUS="$(run_capture "grok final" 120 "$FINAL_TXT" grok -p "Reply with exactly: grok-headless-ok" --cwd "$REPO")"
if [[ "$FINAL_STATUS" -eq 0 ]] && grep -q "grok-headless-ok" "$FINAL_TXT"; then
  pass "grok -p final answer" "headless prompt returned expected text"
else
  fail "grok -p final answer" "exit=$FINAL_STATUS output=$(tail -10 "$FINAL_TXT" | tr '\n' ' ') stderr=$(tail -10 "$FINAL_TXT.stderr" | tr '\n' ' ')"
fi

echo "[4] json and streaming-json output"
JSON_OUT="$FIXTURE_DIR/final.json"
JSON_STATUS="$(run_capture "grok json" 120 "$JSON_OUT" grok -p "Reply with exactly: grok-json-ok" --cwd "$REPO" --output-format json)"
if [[ "$JSON_STATUS" -eq 0 ]] && jq . "$JSON_OUT" >/dev/null 2>&1; then
  pass "json final output" "valid JSON saved"
else
  fail "json final output" "exit=$JSON_STATUS; output is not valid JSON"
fi

STREAM_OUT="$FIXTURE_DIR/streaming-json.jsonl"
STREAM_STATUS="$(run_capture "grok streaming-json" 120 "$STREAM_OUT" grok -p "Reply with exactly: grok-stream-ok" --cwd "$REPO" --output-format streaming-json)"
if [[ "$STREAM_STATUS" -eq 0 ]] && [[ -s "$STREAM_OUT" ]] && awk 'NF {print}' "$STREAM_OUT" | while IFS= read -r line; do echo "$line" | jq . >/dev/null || exit 1; done; then
  SCHEMA_KEYS="$(awk 'NF {print; exit}' "$STREAM_OUT" | jq -r 'keys | join(",")' 2>/dev/null || true)"
  pass "streaming-json schema" "valid JSONL saved; first keys=$SCHEMA_KEYS"
else
  fail "streaming-json schema" "exit=$STREAM_STATUS; invalid or empty JSONL"
fi

echo "[5] session id and resume"
SESSION_ID="anet-grok-probe-$(date +%s)"
SESSION_A="$WORK_ROOT/session-a.txt"
SESSION_B="$WORK_ROOT/session-b.txt"
SESSION_A_STATUS="$(run_capture "grok session-id" 120 "$SESSION_A" grok -p "Remember the token session-token-42. Reply ok." --cwd "$REPO" --session-id "$SESSION_ID")"
SESSION_B_STATUS="$(run_capture "grok resume" 120 "$SESSION_B" grok -p "What token did I ask you to remember? Reply with only the token." --cwd "$REPO" --resume "$SESSION_ID")"
if [[ "$SESSION_A_STATUS" -eq 0 && "$SESSION_B_STATUS" -eq 0 ]] && grep -q "session-token-42" "$SESSION_B"; then
  pass "--session-id + --resume" "resume preserved conversational state"
else
  fail "--session-id + --resume" "session exit=$SESSION_A_STATUS resume exit=$SESSION_B_STATUS resume_output=$(tail -10 "$SESSION_B" | tr '\n' ' ')"
fi

echo "[6] temp repo file edit"
EDIT_OUT="$WORK_ROOT/edit.txt"
EDIT_STATUS="$(run_capture "grok file edit" 180 "$EDIT_OUT" grok -p "Edit probe.txt so its entire contents become exactly: after-grok-edit" --cwd "$REPO")"
if [[ "$EDIT_STATUS" -eq 0 && "$(tr -d '\r\n' <"$REPO/probe.txt")" == "after-grok-edit" ]]; then
  pass "temp repo file edit" "probe.txt updated"
else
  warn "temp repo file edit" "exit=$EDIT_STATUS file=$(tr '\n' ' ' <"$REPO/probe.txt")"
fi

echo "[7] ACP stdio"
ACP_SCRIPT="$WORK_ROOT/acp-probe.mjs"
cat >"$ACP_SCRIPT" <<'EOF_ACP'
import { spawn } from "node:child_process";
import readline from "node:readline";
import process from "node:process";

const cwd = process.argv[2];
const out = [];
const proc = spawn("grok", ["agent", "stdio"], { stdio: ["pipe", "pipe", "pipe"], cwd });
const rl = readline.createInterface({ input: proc.stdout });
const pending = new Map();
let id = 1;
let text = "";

proc.stderr.on("data", chunk => out.push({ stream: "stderr", text: chunk.toString() }));
rl.on("line", line => {
  out.push({ stream: "stdout", raw: line });
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "session/update") {
    const update = msg.params?.update;
    if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text) {
      text += update.content.text;
    }
    return;
  }
  const item = pending.get(msg.id);
  if (!item) return;
  pending.delete(msg.id);
  msg.error ? item.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : item.resolve(msg.result || {});
});

function request(method, params, timeoutMs = 45000) {
  const requestId = id++;
  const payload = { jsonrpc: "2.0", id: requestId, method, params };
  out.push({ stream: "stdin", payload });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(requestId, {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    });
    proc.stdin.write(JSON.stringify(payload) + "\n");
  });
}

try {
  const init = await request("initialize", {
    protocolVersion: "1",
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true
    }
  });
  const authMethods = new Set((init.authMethods || []).map(method => method.id));
  const methodId = authMethods.has("xai.api_key") ? "xai.api_key" : null;
  if (!methodId) throw new Error(`xai.api_key auth not advertised: ${JSON.stringify(init.authMethods || [])}`);
  await request("authenticate", { methodId, meta: { headless: true } });
  const session = await request("session/new", { cwd, mcpServers: [] });
  const sessionId = session.sessionId;
  if (!sessionId) throw new Error(`session/new missing sessionId: ${JSON.stringify(session)}`);
  const prompt = await request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Reply with exactly: grok-acp-ok" }]
  }, 90000);
  await new Promise(resolve => setTimeout(resolve, 1000));
  out.push({ result: { sessionId, stopReason: prompt.stopReason, text } });
  console.log(JSON.stringify({ ok: text.includes("grok-acp-ok"), sessionId, stopReason: prompt.stopReason, text, log: out }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error), text, log: out }));
  process.exitCode = 1;
} finally {
  rl.close();
  proc.kill();
}
EOF_ACP

ACP_JSON="$WORK_ROOT/acp-result.json"
ACP_STATUS="$(run_capture "grok acp" 150 "$ACP_JSON" node "$ACP_SCRIPT" "$REPO")"
jq -c '.log[]?' "$ACP_JSON" >"$FIXTURE_DIR/acp-stdio.jsonl" 2>/dev/null || true
if [[ "$ACP_STATUS" -eq 0 ]] && jq -e '.ok == true' "$ACP_JSON" >/dev/null 2>&1; then
  pass "ACP stdio" "initialize/authenticate/session/new/session/prompt/session/update succeeded"
else
  fail "ACP stdio" "exit=$ACP_STATUS result=$(cat "$ACP_JSON" 2>/dev/null | head -c 500)"
fi

echo "[8] MCP no-op via ACP session"
MCP_SCRIPT="$WORK_ROOT/noop-mcp.js"
cat >"$MCP_SCRIPT" <<'EOF_MCP'
#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
rl.on("line", line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "anet-noop", version: "0.0.1" } } });
  } else if (msg.method === "notifications/initialized") {
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "noop", description: "Return ok", inputSchema: { type: "object", properties: {} } }] } });
  } else if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "noop-ok" }] } });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
EOF_MCP
chmod +x "$MCP_SCRIPT"

MCP_ACP_SCRIPT="$WORK_ROOT/acp-mcp-probe.mjs"
sed "s/mcpServers: \\[\\]/mcpServers: [{ name: 'anet-noop', command: 'node', args: ['$MCP_SCRIPT'] }]/" "$ACP_SCRIPT" >"$MCP_ACP_SCRIPT"
MCP_JSON="$WORK_ROOT/mcp-result.json"
MCP_STATUS="$(run_capture "grok mcp noop" 180 "$MCP_JSON" node "$MCP_ACP_SCRIPT" "$REPO")"
jq -c '.log[]?' "$MCP_JSON" >"$FIXTURE_DIR/mcp-noop.jsonl" 2>/dev/null || true
if [[ "$MCP_STATUS" -eq 0 ]] && jq -e '.ok == true' "$MCP_JSON" >/dev/null 2>&1; then
  pass "MCP no-op tool" "ACP session accepted a local no-op MCP server"
else
  warn "MCP no-op tool" "exit=$MCP_STATUS result=$(cat "$MCP_JSON" 2>/dev/null | head -c 500)"
fi

echo "Probe complete. Report will be written to $REPORT_PATH"
