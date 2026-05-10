#!/bin/bash
set -u

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

check_file() {
  local path="$1"
  local label="$2"
  if [ -f "$path" ]; then pass "$label"; else fail "$label missing: $path"; fi
}

check_absent() {
  local path="$1"
  local label="$2"
  if [ ! -e "$path" ]; then pass "$label"; else fail "$label should not exist: $path"; fi
}

check_grep() {
  local pattern="$1"
  local path="$2"
  local label="$3"
  if grep -Eq -- "$pattern" "$path"; then pass "$label"; else fail "$label"; fi
}

check_no_grep_tree() {
  local pattern="$1"
  local path="$2"
  local label="$3"
  local out
  out=$(grep -R -n -E -- "$pattern" "$path" 2>/dev/null || true)
  if [ -z "$out" ]; then
    pass "$label"
  else
    echo "$out"
    fail "$label"
  fi
}

echo ""
echo "========================================="
echo "  Test 27: Cases + Demo Docs"
echo "========================================="
echo ""

cd /app
rm -rf /app/docs-site/docs/.vitepress/dist

echo "A. Case page inventory"
check_file "docs-site/docs/cases/index.md" "Chinese case index exists"
check_file "docs-site/docs/cases/debate.md" "Chinese debate case exists"
check_file "docs-site/docs/cases/hello-world.md" "Chinese hello-world case exists"
check_file "docs-site/docs/cases/translation-pipeline.md" "Chinese translation case exists"
check_file "docs-site/docs/cases/telegram-squad.md" "Chinese telegram squad case exists"
check_file "docs-site/docs/en/cases/index.md" "English case index exists"
check_file "docs-site/docs/en/cases/debate.md" "English debate case exists"
check_absent "docs-site/docs/cases/code-review.md" "Removed Chinese code-review page"
check_absent "docs-site/docs/cases/idiom-chain.md" "Removed Chinese idiom-chain page"
check_absent "docs-site/docs/cases/mixed-model.md" "Removed Chinese mixed-model page"
check_absent "docs-site/docs/en/cases/code-review.md" "Removed English code-review page"
check_absent "docs-site/docs/en/cases/idiom-chain.md" "Removed English idiom-chain page"
check_absent "docs-site/docs/en/cases/mixed-model.md" "Removed English mixed-model page"
check_no_grep_tree '/cases/(code-review|idiom-chain|mixed-model)|/en/cases/(code-review|idiom-chain|mixed-model)' "docs-site/docs" "No links to removed case routes"
echo ""

echo "B. Demo and case navigation are merged"
check_grep "案例 / Demo.*'/cases/'" "docs-site/docs/.vitepress/config.ts" "Chinese top nav points to cases"
check_grep "Examples / Demo.*'/en/cases/'" "docs-site/docs/.vitepress/config.ts" "English top nav points to examples"
check_grep "辩论赛 Demo.*'/cases/debate'" "docs-site/docs/.vitepress/config.ts" "Chinese sidebar includes debate case"
check_grep "Debate Demo.*'/en/cases/debate'" "docs-site/docs/.vitepress/config.ts" "English sidebar includes debate case"
check_no_grep_tree "link: '/deploy/demo|link: '/deploy/demo-debate|link: '/en/deploy/demo'" "docs-site/docs/.vitepress" "Demo pages are not primary navigation"
check_grep "已合并到案例库" "docs-site/docs/deploy/demo.md" "Chinese demo deploy page is compatibility bridge"
check_grep "已合并到案例库" "docs-site/docs/deploy/demo-debate.md" "Chinese debate deploy page is compatibility bridge"
check_grep "Moved To Examples" "docs-site/docs/en/deploy/demo.md" "English demo deploy page is compatibility bridge"
check_grep "Moved To Examples" "docs-site/docs/en/deploy/demo-debate.md" "English debate deploy page is compatibility bridge"
echo ""

echo "C. Runnable assets referenced by cases"
check_file "demos/hello-world/docker-compose.yml" "hello-world Docker Compose exists"
check_file "demos/translation-pipeline/docker-compose.yml" "translation Docker Compose exists"
check_file "demos/codex-telegram-squad/docker-compose.yml" "telegram squad Docker Compose exists"
check_file "demos/codex-telegram-squad/Dockerfile.agent" "telegram squad agent Dockerfile exists"
check_file "demos/codex-telegram-squad/Dockerfile.server" "telegram squad server Dockerfile exists"
check_grep "MODEL=gpt-5.5" "demos/codex-telegram-squad/docker-compose.yml" "telegram squad compose uses current Codex model"
check_grep "worker-1~5" "docs-site/docs/cases/telegram-squad.md" "Chinese telegram docs use worker service names"
check_grep "worker-1~5" "docs-site/docs/en/cases/telegram-squad.md" "English telegram docs use worker service names"
echo ""

echo "D. CLI demo surface"
mkdir -p /tmp/anet-test-home
HOME=/tmp/anet-test-home bun run /app/agent-network/bin/cli.ts demo >/tmp/anet-demo.txt 2>&1 || true
check_grep "Available demos" "/tmp/anet-demo.txt" "anet demo lists demos"
check_grep "debate" "/tmp/anet-demo.txt" "anet demo includes debate"
check_grep "monitor" "/tmp/anet-demo.txt" "anet demo includes monitor"
HOME=/tmp/anet-test-home bun run /app/agent-network/bin/cli.ts demo debate --help >/tmp/anet-demo-debate-help.txt 2>&1 || true
check_grep "--quick" "/tmp/anet-demo-debate-help.txt" "debate help includes quick mode"
check_grep "--no-network" "/tmp/anet-demo-debate-help.txt" "debate help includes no-network option"
check_grep "--network <id>" "/tmp/anet-demo-debate-help.txt" "debate help includes explicit network option"
echo ""

echo "E. VitePress build"
cd /app/docs-site
if npm run build; then
  pass "docs-site build succeeds"
else
  fail "docs-site build fails"
fi
cd /app/docs-site/docs/.vitepress/dist
check_file "cases/index.html" "Built Chinese case index"
check_file "cases/debate.html" "Built Chinese debate case"
check_file "cases/hello-world.html" "Built Chinese hello-world case"
check_file "cases/translation-pipeline.html" "Built Chinese translation case"
check_file "cases/telegram-squad.html" "Built Chinese telegram case"
check_file "en/cases/index.html" "Built English case index"
check_file "en/cases/debate.html" "Built English debate case"
check_absent "cases/code-review.html" "Removed Chinese code-review output"
check_absent "cases/idiom-chain.html" "Removed Chinese idiom-chain output"
check_absent "cases/mixed-model.html" "Removed Chinese mixed-model output"
check_absent "en/cases/code-review.html" "Removed English code-review output"
check_absent "en/cases/idiom-chain.html" "Removed English idiom-chain output"
check_absent "en/cases/mixed-model.html" "Removed English mixed-model output"
echo ""

echo "========================================="
echo "Result: ${PASS} passed, ${FAIL} failed"
echo "========================================="

[ "${FAIL}" -eq 0 ]
