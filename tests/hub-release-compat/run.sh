#!/usr/bin/env bash
# Hub release compatibility, run once per Hub release prep (see NOT-IN-CI.md):
#   A  (twice) the desktop app's REST/MCP calls against the last published Hub
#      (baseline, from npm) and against this tree's server/ (candidate);
#      every step must be the same or a superset — compare.ts
#   B  upgrade → rollback → re-upgrade on one database — run-upgrade.sh
#
#   BASE_VERSION=0.9.0-preview.74 bash tests/hub-release-compat/run.sh
#
# Release-specific checks are opt-in env passed through to the container:
#   CHECK_75=1 SCHED_BASELINE=counted          (phase A)
#   CHECK_BYTES=1 EXPECT_BACKFILL=0 OLD_LABEL NEW_LABEL   (phase B)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${BASE_VERSION:?set BASE_VERSION to the last published @sleep2agi/commhub-server version}"
APP_TAGS=${APP_TAGS:-desktop-v0.2.162,desktop-v0.2.163,desktop-v0.2.164,desktop-v0.2.165,desktop-v0.2.166}
APP_REPO=${APP_REPO:-https://github.com/sleep2agi/agent-network-app.git}
IMAGE=anet-hub-release-compat:local

# Say which tree the candidate is; a dirty tree means the result is not about HEAD.
echo "candidate: $(git -C "$ROOT" rev-parse HEAD) dirty_files=$(git -C "$ROOT" status --porcelain -- server | wc -l)  baseline: $BASE_VERSION"

CTX=$(mktemp -d); trap 'rm -rf "$CTX"' EXIT
mkdir -p "$CTX/server" "$CTX/compat/apps"
cp -r "$ROOT/server/package.json" "$ROOT/server/src" "$ROOT/server/bin" "$CTX/server/"
cp -r "$ROOT/tests/hub-release-compat/." "$CTX/compat/"
for tag in ${APP_TAGS//,/ }; do
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$tag" "$APP_REPO" "$CTX/compat/apps/$tag" || { echo "FAIL: cannot clone app tag $tag"; exit 1; }
done
docker build -q --build-arg BASE_VERSION="$BASE_VERSION" -t "$IMAGE" -f "$ROOT/tests/hub-release-compat/Dockerfile" "$CTX" >/dev/null || { echo "FAIL: docker build"; exit 1; }

envs=(-e APP_TAGS="$APP_TAGS")
for v in CHECK_75 SCHED_BASELINE CHECK_BYTES EXPECT_BACKFILL OLD_LABEL NEW_LABEL; do
  if [[ -n "${!v:-}" ]]; then envs+=(-e "$v=${!v}"); fi
done

fail=0
for i in 1 2; do
  rc=0; docker run --rm "${envs[@]}" "$IMAGE" > "$CTX/A$i.log" 2>&1 || rc=$?
  echo "A$i rc=$rc  $(grep -E '^steps=' "$CTX/A$i.log" || echo 'no summary line')"
  grep -E '^(UNEXPECTED|FAIL)' "$CTX/A$i.log" || true
  [[ $rc -eq 0 ]] || fail=1
done
rc=0; docker run --rm "${envs[@]}" --entrypoint bash "$IMAGE" /compat/run-upgrade.sh > "$CTX/B.log" 2>&1 || rc=$?
echo "B rc=$rc  $(grep -E '^upgrade_check_failures=' "$CTX/B.log" || echo 'no summary line')"
grep -E '^FAIL' "$CTX/B.log" || true
[[ $rc -eq 0 ]] || fail=1
if [[ -n "${KEEP_LOGS:-}" ]]; then mkdir -p "$KEEP_LOGS" && cp "$CTX"/A1.log "$CTX"/A2.log "$CTX"/B.log "$KEEP_LOGS"/; fi
exit $fail
