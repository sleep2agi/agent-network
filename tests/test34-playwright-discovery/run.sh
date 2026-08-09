#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test34-playwright-discovery.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test34 — isolate Playwright specs from Bun test discovery"
echo "source_commit=${TEST34_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

ROOT=/workspace/agent-network
PW=$ROOT/tests/docker-e2e/playwright

echo "L0 agent-network typecheck"
(cd "$ROOT" && bun run typecheck)

echo "L1 root bun test must not collect Playwright-runner files"
(cd "$ROOT" && bun test src/client.test.ts tests/docker-e2e/playwright) >/tmp/test34-bun.log 2>&1 || {
  cat /tmp/test34-bun.log
  echo "FAIL_BUN_DISCOVERY_ISOLATION"
  exit 1
}
if grep -Fq 'Playwright Test did not expect test()' /tmp/test34-bun.log \
  || grep -Fq "Cannot find module '@playwright/test'" /tmp/test34-bun.log; then
  cat /tmp/test34-bun.log
  echo "FAIL_BUN_COLLECTED_PLAYWRIGHT"
  exit 1
fi
tail -20 /tmp/test34-bun.log

echo "L2 real Playwright runner must still discover exactly seven scenarios"
(cd "$PW" && bun install --ignore-scripts >/tmp/test34-pw-install.log 2>&1)
(cd "$PW" && ./node_modules/.bin/playwright test --list) >/tmp/test34-pw-list.log 2>&1
cat /tmp/test34-pw-list.log
grep -Fq 'Total: 7 tests in 7 files' /tmp/test34-pw-list.log

if [[ "${TEST34_SKIP_MUTATIONS:-0}" != "1" ]]; then
  echo "L3 witnessed-red: restore one .spec.ts Bun-discovery file"
  first_pw=$(find "$PW" -maxdepth 1 -type f -name '*.pw.ts' | sort | head -1)
  [[ -n "$first_pw" ]] || { echo "FAIL: no .pw.ts scenario found"; exit 1; }
  first_spec=${first_pw%.pw.ts}.spec.ts
  mv "$first_pw" "$first_spec"
  set +e
  (cd "$ROOT" && bun test src/client.test.ts tests/docker-e2e/playwright) >/tmp/test34-mutation-bun.log 2>&1
  mutation_rc=$?
  set -e
  mv "$first_spec" "$first_pw"
  if [[ "$mutation_rc" -eq 0 ]]; then
    echo "MUTATION_FALSE_GREEN: bun-playwright-discovery"
    exit 1
  fi
  grep -Eq "Cannot find module '@playwright/test'|Playwright Test did not expect test\(\)" \
    /tmp/test34-mutation-bun.log || {
      echo "MUTATION_WRONG_RED: bun-playwright-discovery"
      cat /tmp/test34-mutation-bun.log
      exit 1
    }
  echo "MUTATION_RED: bun-playwright-discovery rc=$mutation_rc"

  echo "L4 witnessed-red: remove explicit Playwright testMatch"
  cp "$PW/playwright.config.ts" /tmp/test34-playwright.config.ts
  sed -i '/testMatch:.*\.pw\.ts/d' "$PW/playwright.config.ts"
  set +e
  (cd "$PW" && ./node_modules/.bin/playwright test --list) >/tmp/test34-mutation-pw.log 2>&1
  playwright_mutation_rc=$?
  set -e
  cp /tmp/test34-playwright.config.ts "$PW/playwright.config.ts"
  if [[ "$playwright_mutation_rc" -eq 0 ]]; then
    echo "MUTATION_FALSE_GREEN: playwright-explicit-discovery"
    cat /tmp/test34-mutation-pw.log
    exit 1
  fi
  grep -Fq 'No tests found' /tmp/test34-mutation-pw.log || {
    echo "MUTATION_WRONG_RED: playwright-explicit-discovery"
    cat /tmp/test34-mutation-pw.log
    exit 1
  }
  echo "MUTATION_RED: playwright-explicit-discovery rc=$playwright_mutation_rc"
fi

echo "RESULT: PASS"
