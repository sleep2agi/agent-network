#!/bin/bash
# ╔══════════════════════════════════════════════════════╗
# ║  Parallel Docker Test Runner                          ║
# ║  Builds + runs 3 test suites simultaneously            ║
# ║  Usage: bash tests/run-parallel.sh                     ║
# ╚══════════════════════════════════════════════════════╝

echo "═══ Building 3 test images in parallel ═══"
sg docker -c "docker build -t anet-test1 -f tests/test1-newuser/Dockerfile ." &
sg docker -c "docker build -t anet-test2 -f tests/test2-collab/Dockerfile ." &
sg docker -c "docker build -t anet-test3 -f tests/test3-security/Dockerfile ." &
wait
echo "═══ Build complete ═══"
echo ""

echo "═══ Running 3 tests in parallel ═══"
sg docker -c "docker run --rm anet-test1" > /tmp/test1-result.txt 2>&1 &
PID1=$!
sg docker -c "docker run --rm anet-test2" > /tmp/test2-result.txt 2>&1 &
PID2=$!
sg docker -c "docker run --rm anet-test3" > /tmp/test3-result.txt 2>&1 &
PID3=$!

wait $PID1; R1=$?
wait $PID2; R2=$?
wait $PID3; R3=$?

echo ""
echo "═══ Results ═══"
echo ""
echo "--- Test 1: New User Experience ---"
tail -5 /tmp/test1-result.txt
echo ""
echo "--- Test 2: Multi-User Collaboration ---"
tail -5 /tmp/test2-result.txt
echo ""
echo "--- Test 3: Security + Boundaries ---"
tail -5 /tmp/test3-result.txt
echo ""

TOTAL_FAIL=0
[ $R1 -ne 0 ] && TOTAL_FAIL=$((TOTAL_FAIL+1))
[ $R2 -ne 0 ] && TOTAL_FAIL=$((TOTAL_FAIL+1))
[ $R3 -ne 0 ] && TOTAL_FAIL=$((TOTAL_FAIL+1))

echo "═══════════════════════════════════════════"
echo "  Overall: $((3-TOTAL_FAIL))/3 suites passed"
echo "═══════════════════════════════════════════"

[ $TOTAL_FAIL -eq 0 ] && exit 0 || exit 1
