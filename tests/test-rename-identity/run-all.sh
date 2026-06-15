#!/usr/bin/env bash
# Run all 14 cases sequentially, write top-level summary.
set -u
mkdir -p /artifacts
: > /artifacts/MATRIX.md
echo "# PR-5 #146 rename family — 14-case matrix" > /artifacts/REPORT.md
echo "Built at: $(date -u +%FT%TZ)" >> /artifacts/REPORT.md
echo "Stack: main HEAD (PR-1+2+3+4 merged) — agent-network / agent-node / commhub-server" >> /artifacts/REPORT.md
echo >> /artifacts/REPORT.md
echo "| # | Verdict | Detail |" >> /artifacts/MATRIX.md
echo "|---|---------|--------|" >> /artifacts/MATRIX.md

PASS_COUNT=0; FAIL_COUNT=0
for n in $(seq 1 14); do
  CASE_FILE=$(ls /harness/cases/case-$(printf '%02d' "$n")-*.sh 2>/dev/null | head -1)
  if [ -z "$CASE_FILE" ]; then
    echo "| $n | SKIP | no case file" >> /artifacts/MATRIX.md
    continue
  fi
  /harness/run-case.sh "$n"
  RC=$?
  if [ $RC -eq 0 ]; then
    PASS_COUNT=$((PASS_COUNT+1))
    echo "| $n | ✅ PASS | $(grep -m1 '^_CASE_VERDICT' /artifacts/case-$n/verdict 2>/dev/null | cut -d= -f2-) |" >> /artifacts/MATRIX.md
  else
    FAIL_COUNT=$((FAIL_COUNT+1))
    echo "| $n | ❌ FAIL | $(grep -m1 '^_CASE_VERDICT' /artifacts/case-$n/verdict 2>/dev/null | cut -d= -f2-) |" >> /artifacts/MATRIX.md
  fi
done

cat >> /artifacts/REPORT.md <<EOF
## Verdict matrix
$(cat /artifacts/MATRIX.md)

## Summary
- PASS: $PASS_COUNT / 14
- FAIL: $FAIL_COUNT / 14

EOF
cat /artifacts/REPORT.md
exit $FAIL_COUNT
