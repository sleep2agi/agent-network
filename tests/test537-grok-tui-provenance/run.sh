#!/bin/sh
set -eu

expected="${EXPECTED_SOURCE_COMMIT:-}"
if [ -z "$expected" ]; then
  echo "FAIL: EXPECTED_SOURCE_COMMIT is required"
  exit 2
fi

failed=0
for test_id in 219 224 225; do
  report="/candidate/docs/tests/report-test${test_id}.txt"
  observed="$(sed -n 's/^source_commit=//p' "$report" | head -n 1)"
  if [ -z "$observed" ]; then
    echo "FAIL: test${test_id} has no source_commit"
    failed=1
  elif [ "$observed" != "$expected" ]; then
    echo "FAIL: test${test_id} source_commit=$observed expected=$expected"
    failed=1
  else
    echo "PASS: test${test_id} source_commit=$observed"
  fi
done

archive_marker="$(tr -d '\r\n' < /candidate/tests/test225-grok-preview-package-live/source-commit.txt)"
if [ "$archive_marker" != "$expected" ]; then
  echo "FAIL: candidate archive source_commit=$archive_marker expected=$expected"
  failed=1
else
  echo "PASS: candidate archive source_commit=$archive_marker"
fi

if [ "$failed" -ne 0 ]; then
  echo "RESULT: FAIL — exact-candidate provenance is not established"
  exit 1
fi

echo "RESULT: PASS — all saved reports bind to $expected"
