#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test234-grok-profile-disclosure.txt"
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"

run() {
  printf '\n$ %q' "$1" | tee -a "$REPORT"
  shift
  printf ' %q' "$@" | tee -a "$REPORT"
  printf '\n' | tee -a "$REPORT"
  "$@" 2>&1 | tee -a "$REPORT"
}

printf '%s\n' \
  '# test234 — Grok profile disclosure and session-pinning runbook' \
  "source_commit=$SOURCE_COMMIT" \
  'scope=exact default/x-search/invalid banner text, resume warning, docs, CLI build' \
  | tee -a "$REPORT"

run disclosure-unit bun test /workspace/agent-network/src/grok-copresence-disclosure.test.ts

run cli-build bun build /workspace/agent-network/bin/cli.ts \
  --outdir /tmp/agent-network-dist --target node \
  --external @inquirer/prompts \
  --external @sleep2agi/commhub-server \
  --external bun:sqlite --external node-pty \
  --external '../../server/*'

run runbook-session-pin bash -ceu '
  doc=/workspace/docs/grok-build-cli-preview.md
  grep -Fq "Grok 0.2.93 fixes the available tool inventory when it creates a session" "$doc"
  grep -Fq "anet node start grok-shared --new-session" "$doc"
  grep -Fq "resumes the old capability set" "$doc"
'

run cli-wiring bash -ceu '
  src=/workspace/agent-network/bin/cli.ts
  grep -Fq "printGrokCopresenceWarning(undefined, profile.tools, \"resume\")" "$src"
  grep -Fq "printGrokCopresenceWarning(nodeId, profile.tools, willResume ? \"resume\" : \"new\")" "$src"
  count=$(grep -c "printGrokCopresenceWarning" "$src")
  test "$count" -eq 7
'

# Witnessed-red: deleting the exact WebSearch recognition must make the same
# unchanged behavior tests fail. A green mutation would mean the x-search
# disclosure is decorative rather than protected.
mkdir -p /tmp/mutation
cp /workspace/agent-network/src/grok-copresence-disclosure.ts /tmp/mutation/grok-copresence-disclosure.ts
cp /workspace/agent-network/src/grok-copresence-disclosure.test.ts /tmp/mutation/grok-copresence-disclosure.test.ts
sed -i 's/configured\[0\] === "WebSearch"/configured[0] === "__mutation_disabled__"/' \
  /tmp/mutation/grok-copresence-disclosure.ts
set +e
bun test /tmp/mutation/grok-copresence-disclosure.test.ts > /tmp/mutation.out 2>&1
mutation_rc=$?
set -e
cat /tmp/mutation.out | tee -a "$REPORT"
if test "$mutation_rc" -eq 0; then
  printf 'FAIL: WebSearch disclosure mutation stayed green\n' | tee -a "$REPORT"
  exit 1
fi
printf 'PASS: witnessed-red WebSearch recognition mutation rc=%s\n' "$mutation_rc" | tee -a "$REPORT"

printf '\nSummary: PASS (4 unit tests; CLI build; runbook/wiring gates; mutation red)\n' | tee -a "$REPORT"
