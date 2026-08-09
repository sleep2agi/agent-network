#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test609-dashboard-chat-doc-path.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test609 — Dashboard ChatPanel documentation path"
echo "source_commit=${TEST609_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_contract() {
  node tests/dashboard-chat-doc-path.test.mjs
}

echo "L0 bilingual route contract"
run_contract

echo "L1 VitePress production build"
npm run build --prefix docs-site
test -s docs-site/docs/.vitepress/dist/guide/getting-started.html
test -s docs-site/docs/.vitepress/dist/en/guide/getting-started.html
test -s docs-site/docs/.vitepress/dist/guide/dashboard.html
test -s docs-site/docs/.vitepress/dist/en/guide/dashboard.html

echo "L2 witnessed-red: removing the no-standalone-page disclosure"
cp docs-site/docs/guide/dashboard.md /tmp/test609-dashboard.md
sed -i 's/不存在单独的 Chat 导航页/打开 Chat 导航页/' docs-site/docs/guide/dashboard.md
grep -Fq '打开 Chat 导航页' docs-site/docs/guide/dashboard.md
set +e
run_contract >/tmp/test609-red.log 2>&1
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: standalone-chat-page-disclosure"
  exit 1
fi
test -s /tmp/test609-red.log
echo "MUTATION_RED: standalone-chat-page-disclosure rc=$rc"
cp /tmp/test609-dashboard.md docs-site/docs/guide/dashboard.md

echo "L3 restored green"
run_contract
echo "RESULT: PASS"
