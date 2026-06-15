#!/usr/bin/env bash
# Run a single case by number: /harness/run-case.sh N
# Reads cases/case-NN-*.sh
set -u
N="${1:?usage: run-case.sh <case-number>}"
ART_DIR="/artifacts/case-$N"
mkdir -p "$ART_DIR"
export ART_DIR
export HUB_URL=http://127.0.0.1:9200

CASE_FILE=$(ls /harness/cases/case-$(printf '%02d' "$N")-*.sh 2>/dev/null | head -1)
[ -n "$CASE_FILE" ] || { echo "no case file for #$N (looked for /harness/cases/case-$(printf '%02d' $N)-*.sh)"; exit 1; }

echo "[run-case] starting #$N: $CASE_FILE"
bash "$CASE_FILE"
RC=$?
echo "[run-case] #$N exit rc=$RC"
exit $RC
