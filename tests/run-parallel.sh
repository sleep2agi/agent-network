#!/bin/bash
set -u

# ╔══════════════════════════════════════════════════════╗
# ║  Parallel Docker Test Runner                          ║
# ║  Builds + runs 7 test suites simultaneously            ║
# ║  Usage: bash tests/run-parallel.sh                     ║
# ╚══════════════════════════════════════════════════════╝

find_dockerfile() {
  local i="$1"
  local match
  match=$(find "tests" -maxdepth 2 -path "tests/test${i}-*/Dockerfile" | head -n 1)
  [ -n "$match" ] && printf '%s\n' "$match"
}

echo "═══ Building 7 test images in parallel ═══"
for i in 1 2 3 4 5 6 7; do
  dockerfile=$(find_dockerfile "$i")
  if [ -z "${dockerfile:-}" ]; then
    echo "missing Dockerfile for test $i"
    continue
  fi
  sg docker -c "docker build -t anet-test$i -f $dockerfile ." &
done
wait
echo "═══ Build complete ═══"
echo ""

echo "═══ Running 7 tests in parallel ═══"
for i in 1 2 3 4 5 6 7; do
  dockerfile=$(find_dockerfile "$i")
  if [ -z "${dockerfile:-}" ]; then
    printf 'missing Dockerfile for test %s\n' "$i" > "/tmp/t${i}.txt"
    continue
  fi
  sg docker -c "docker run --rm anet-test$i" > "/tmp/t${i}.txt" 2>&1 &
done
wait

echo ""
echo "═══ Results ═══"
echo ""
for i in 1 2 3 4 5 6 7; do
  echo "=== Test $i ==="
  tail -5 "/tmp/t${i}.txt"
done
