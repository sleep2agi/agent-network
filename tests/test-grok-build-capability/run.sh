#!/usr/bin/env bash
# Grok Build ACP capability probe for Agent Network runtime integration.
set -euo pipefail

REPORT_PATH="${REPORT_PATH:-/work/docs/tests/report-grok-build-capability.md}"
FIXTURE_DIR="${FIXTURE_DIR:-/work/docs/tests/fixtures/grok-build}"
WORK_ROOT="${WORK_ROOT:-/tmp/grok-build-probe}"
TIMEOUT_BIN="${TIMEOUT_BIN:-timeout}"
GROK_INSTALL_URL="${GROK_INSTALL_URL:-https://x.ai/cli/install.sh}"
HOST_GROK_CACHE="${HOST_GROK_CACHE:-/host-grok}"
ACP_TIMEOUT_SECONDS="${ACP_TIMEOUT_SECONDS:-180}"
HEADLESS_TIMEOUT_SECONDS="${HEADLESS_TIMEOUT_SECONDS:-90}"

PASS=0
FAIL=0
SKIP=0
WARN=0
DETAILS=""
VERDICT="Wait"
GROK_VERSION="not checked"
AUTH_MODE="none"

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

redact_file() {
  sed -E \
    -e 's/(xai-)[A-Za-z0-9._-]+/\1REDACTED/g' \
    -e 's/(Bearer )[A-Za-z0-9._-]+/\1REDACTED/g' \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/REDACTED_EMAIL/g' \
    -e 's/("access_token"[[:space:]]*:[[:space:]]*")[^"]+/\1REDACTED/g' \
    -e 's/("refresh_token"[[:space:]]*:[[:space:]]*")[^"]+/\1REDACTED/g' \
    -e 's/("email"[[:space:]]*:[[:space:]]*")[^"]+/\1REDACTED_EMAIL/g' \
    "$1"
}

run_capture() {
  local seconds="$1"
  local outfile="$2"
  shift 2
  set +e
  "$TIMEOUT_BIN" "$seconds" "$@" >"$outfile" 2>"$outfile.stderr"
  local status=$?
  set -e
  redact_file "$outfile" >"${outfile}.redacted" || true
  redact_file "$outfile.stderr" >"${outfile}.stderr.redacted" || true
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
  else
    VERDICT="Wait"
  fi

  cat >"$REPORT_PATH" <<EOF_REPORT
# Grok Build ACP Capability Probe

Date: $generated_at
Suite: tests/test-grok-build-capability
Runtime target: grok-build-acp
Verdict: **$VERDICT**

## Summary

- PASS: $PASS
- FAIL: $FAIL
- SKIP: $SKIP
- WARN: $WARN
- grok version: \`$GROK_VERSION\`
- auth mode: \`$AUTH_MODE\`

## Results

| Probe | Status | Detail |
|---|---|---|
$DETAILS

## Fixtures

- ACP stdio: \`docs/tests/fixtures/grok-build/acp-stdio.jsonl\`
- ACP summary: \`docs/tests/fixtures/grok-build/acp-summary.json\`
- headless JSON smoke: \`docs/tests/fixtures/grok-build/final.json\`
- file edit diff: \`docs/tests/fixtures/grok-build/file-edit.diff\`

## Notes

- This suite installs Grok Build inside Docker using \`$GROK_INSTALL_URL\`.
- Auth precedence: \`GROK_CODE_XAI_API_KEY\` env, then read-only host cache mount at \`/host-grok\`, then clean SKIP.
- Host cache files are never copied into the repo or report. Output fixtures are redacted.
- ACP is the primary runtime gate. Headless \`grok -p\` is only used for install/auth smoke.
- The probe does not enable \`--always-approve\` by default.
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
    warn "grok install" "installer failed with status $INSTALL_STATUS"
  fi
fi

if command -v grok >/dev/null 2>&1; then
  VERSION_OUT="$WORK_ROOT/version.txt"
  VERSION_STATUS="$(run_capture 20 "$VERSION_OUT" grok --version)"
  if [[ "$VERSION_STATUS" -eq 0 ]]; then
    GROK_VERSION="$(tr '\n' ' ' <"$VERSION_OUT.redacted" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
    pass "grok --version" "$GROK_VERSION"
  else
    fail "grok --version" "status $VERSION_STATUS"
  fi
else
  fail "grok install" "grok binary not found after installer"
fi

echo "[1] auth mode detection"
if [[ -n "${GROK_CODE_XAI_API_KEY:-}" ]]; then
  AUTH_MODE="env:GROK_CODE_XAI_API_KEY"
  pass "auth source" "using GROK_CODE_XAI_API_KEY env"
elif [[ -f "$HOST_GROK_CACHE/auth.json" ]]; then
  AUTH_MODE="host-cache"
  mkdir -p "$HOME/.grok"
  # Symlink only the minimal mounted cache files. Do not copy secrets.
  for name in auth.json agent_id config.toml; do
    if [[ -f "$HOST_GROK_CACHE/$name" && ! -e "$HOME/.grok/$name" ]]; then
      ln -s "$HOST_GROK_CACHE/$name" "$HOME/.grok/$name"
    fi
  done
  pass "auth source" "using read-only mounted ~/.grok cache"
else
  AUTH_MODE="none"
  skip "auth source" "no GROK_CODE_XAI_API_KEY and no mounted ~/.grok/auth.json"
fi

echo "[2] permission default"
HELP_OUT="$WORK_ROOT/help.txt"
HELP_STATUS="$(run_capture 20 "$HELP_OUT" grok --help)"
if [[ "$HELP_STATUS" -eq 0 ]] && grep -q -- "--always-approve" "$HELP_OUT.redacted"; then
  pass "permission default" "--always-approve exists but probe does not enable it"
else
  warn "permission default" "could not confirm --always-approve flag from help"
fi

if [[ "$AUTH_MODE" == "none" ]]; then
  skip "headless auth smoke" "requires env token or mounted auth cache"
  skip "ACP stdio" "requires env token or mounted auth cache"
  skip "ACP resume" "requires env token or mounted auth cache"
  skip "temp repo file edit" "requires env token or mounted auth cache"
  exit 0
fi

echo "[3] headless auth smoke"
HEADLESS_OUT="$WORK_ROOT/final.json"
HEADLESS_STATUS="$(run_capture "$HEADLESS_TIMEOUT_SECONDS" "$HEADLESS_OUT" grok -p "Reply with exactly: OK" --output-format json --no-subagents --disable-web-search)"
if [[ "$HEADLESS_STATUS" -eq 0 ]]; then
  cp "$HEADLESS_OUT.redacted" "$FIXTURE_DIR/final.json"
  pass "headless auth smoke" "grok -p json succeeded"
else
  cp "$HEADLESS_OUT.redacted" "$FIXTURE_DIR/final.json" 2>/dev/null || true
  cp "$HEADLESS_OUT.stderr.redacted" "$FIXTURE_DIR/final.stderr.txt" 2>/dev/null || true
  fail "headless auth smoke" "grok -p json failed with status $HEADLESS_STATUS"
  skip "ACP stdio" "auth smoke failed"
  skip "ACP resume" "auth smoke failed"
  skip "temp repo file edit" "auth smoke failed"
  exit 0
fi

echo "[4] ACP stdio probe"
ACP_SCRIPT="$WORK_ROOT/acp-probe.mjs"
cat >"$ACP_SCRIPT" <<'EOF_NODE'
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const fixture = process.env.FIXTURE_DIR;
const timeoutMs = Number(process.env.ACP_TIMEOUT_MS || "180000");
mkdirSync(fixture, { recursive: true });
const logPath = join(fixture, "acp-stdio.jsonl");
const summaryPath = join(fixture, "acp-summary.json");
const diffPath = join(fixture, "file-edit.diff");
writeFileSync(logPath, "");

const redact = (value) => JSON.stringify(value)
  .replace(/(xai-)[A-Za-z0-9._-]+/g, "$1REDACTED")
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "REDACTED_EMAIL")
  .replace(/("access_token"\\s*:\\s*")[^"]+/g, "$1REDACTED")
  .replace(/("refresh_token"\\s*:\\s*")[^"]+/g, "$1REDACTED")
  .replace(/("email"\\s*:\\s*")[^"]+/g, "$1REDACTED_EMAIL");

const record = (direction, payload) => {
  writeFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), direction, payload: JSON.parse(redact(payload)) }) + "\n", { flag: "a" });
};

const cwd = mkdtempSync(join(tmpdir(), "grok-acp-repo-"));
writeFileSync(join(cwd, "README.md"), "# probe\n\noriginal\n");
writeFileSync(join(cwd, "AGENTS.md"), "Keep replies short. For this probe, edit README.md only when asked.\n");

const proc = spawn("grok", ["agent", "stdio"], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

const rl = createInterface({ input: proc.stdout });
const pending = new Map();
let nextId = 1;
let updateCount = 0;
let assistantText = "";
let sessionId = null;
let initialized = false;
let authenticated = false;
let prompted = false;
let permissionRequests = 0;
let permissionAllowedOnce = false;

const timer = setTimeout(() => {
  writeSummary("timeout");
  proc.kill("SIGTERM");
  process.exit(124);
}, timeoutMs);

proc.stderr.on("data", (chunk) => {
  record("stderr", { text: chunk.toString("utf8").slice(0, 2000) });
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    record("stdout.raw", { line: line.slice(0, 2000) });
    return;
  }
  record("recv", message);
  if (message.method === "session/update") {
    updateCount += 1;
    const params = message.params ?? {};
    const candidate = params.text
      ?? params.delta
      ?? params.content
      ?? params.chunk?.text
      ?? params.update?.text
      ?? params.message?.text
      ?? "";
    if (typeof candidate === "string") assistantText += candidate;
  }
  if (message.method && message.id !== undefined) {
    handleServerRequest(message);
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result ?? {});
  }
});

const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  const payload = { jsonrpc: "2.0", id, method, params };
  record("send", payload);
  proc.stdin.write(JSON.stringify(payload) + "\n");
});

function respond(id, result, error = null) {
  const payload = error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
  record("send", payload);
  proc.stdin.write(JSON.stringify(payload) + "\n");
}

function safePath(inputPath) {
  const abs = resolve(inputPath);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..") || rel === ".." || abs === cwd) {
    throw new Error(`path outside probe cwd: ${inputPath}`);
  }
  return abs;
}

function handleServerRequest(message) {
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};
  try {
    if (method === "fs/read_text_file" || method === "fs/readTextFile") {
      const text = readFileSync(safePath(params.path), "utf8");
      respond(id, { content: text });
      return;
    }
    if (method === "fs/write_text_file" || method === "fs/writeTextFile") {
      const content = params.content ?? params.text ?? "";
      writeFileSync(safePath(params.path), String(content));
      respond(id, {});
      return;
    }
    if (method === "session/request_permission") {
      permissionRequests += 1;
      const options = Array.isArray(params.options) ? params.options : [];
      const allowOnce = options.find((option) => option.optionId === "allow-once") ?? options.find((option) => option.kind === "allow_once");
      if (!allowOnce) throw new Error("permission request did not include allow-once");
      permissionAllowedOnce = true;
      respond(id, { outcome: { outcome: "selected", optionId: allowOnce.optionId ?? "allow-once" } });
      return;
    }
    respond(id, null, { code: -32601, message: `unsupported client method: ${method}` });
  } catch (error) {
    respond(id, null, { code: -32000, message: error.message });
  }
}

function extractSessionId(result) {
  return result.sessionId ?? result.session_id ?? result.session?.id ?? result.session?.sessionId ?? null;
}

function writeSummary(status) {
  let readme = "";
  try { readme = readFileSync(join(cwd, "README.md"), "utf8"); } catch {}
  writeFileSync(diffPath, readme);
  writeFileSync(summaryPath, JSON.stringify({
    status,
    initialized,
    authenticated,
    sessionId,
    prompted,
    updateCount,
    assistantTextPreview: assistantText.trim().slice(0, 500),
    cwd,
    permissionRequests,
    permissionAllowedOnce,
    readmeChanged: readme.includes("grok-acp-probe-success"),
  }, null, 2));
}

try {
  const init = await request("initialize", {
    protocolVersion: "1",
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  });
  initialized = true;

  const authMethods = new Set((init.authMethods ?? []).map((method) => method.id));
  const methodId =
    process.env.GROK_CODE_XAI_API_KEY && authMethods.has("xai.api_key")
      ? "xai.api_key"
      : authMethods.has("cached_token")
        ? "cached_token"
        : authMethods.has("xai.api_key")
          ? "xai.api_key"
          : null;

  if (!methodId) throw new Error(`no supported auth method; advertised=${JSON.stringify([...authMethods])}`);
  await request("authenticate", { methodId, meta: { headless: true } });
  authenticated = true;

  const created = await request("session/new", { cwd, mcpServers: [] });
  sessionId = extractSessionId(created);
  if (!sessionId) throw new Error(`session/new returned no session id: ${JSON.stringify(created)}`);

  await request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Reply with the words ACP OK, then edit README.md and add a new line containing exactly grok-acp-probe-success." }],
  });
  prompted = true;

  let stable = 0;
  let lastText = "";
  for (let i = 0; i < 80; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const readme = existsSync(join(cwd, "README.md")) ? readFileSync(join(cwd, "README.md"), "utf8") : "";
    if (readme.includes("grok-acp-probe-success")) break;
    if (assistantText === lastText) stable += 1;
    else stable = 0;
    lastText = assistantText;
    if (stable >= 8 && updateCount > 0) break;
  }

  if (!updateCount) throw new Error("no session/update events observed");
  writeSummary("ok");
  clearTimeout(timer);
  rl.close();
  proc.kill("SIGTERM");
} catch (error) {
  record("error", { message: error.message });
  writeSummary("error");
  clearTimeout(timer);
  rl.close();
  proc.kill("SIGTERM");
  process.exit(1);
}
EOF_NODE

ACP_STATUS="$(run_capture "$ACP_TIMEOUT_SECONDS" "$WORK_ROOT/acp-node.out" env FIXTURE_DIR="$FIXTURE_DIR" ACP_TIMEOUT_MS="$((ACP_TIMEOUT_SECONDS * 1000))" node "$ACP_SCRIPT")"
if [[ "$ACP_STATUS" -eq 0 ]]; then
  pass "ACP stdio" "initialize/authenticate/session/new/session/prompt/session/update succeeded"
else
  fail "ACP stdio" "ACP probe failed with status $ACP_STATUS"
fi

if [[ -s "$FIXTURE_DIR/acp-summary.json" ]] && jq -e '.sessionId and .updateCount > 0' "$FIXTURE_DIR/acp-summary.json" >/dev/null 2>&1; then
  pass "ACP resume basis" "sessionId captured for future runtime resume"
else
  warn "ACP resume basis" "sessionId or session/update missing from ACP summary"
fi

if [[ -s "$FIXTURE_DIR/acp-summary.json" ]] && jq -e '.permissionRequests > 0 and .permissionAllowedOnce == true' "$FIXTURE_DIR/acp-summary.json" >/dev/null 2>&1; then
  pass "permission behavior" "edit requested explicit permission; probe allowed once"
else
  warn "permission behavior" "no explicit permission request observed"
fi

if [[ -s "$FIXTURE_DIR/acp-summary.json" ]] && jq -e '.readmeChanged == true' "$FIXTURE_DIR/acp-summary.json" >/dev/null 2>&1; then
  pass "temp repo file edit" "README.md changed through ACP session"
else
  warn "temp repo file edit" "file edit was not confirmed; may require approval mode or different ACP fs handling"
fi
