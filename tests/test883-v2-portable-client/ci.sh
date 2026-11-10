#!/usr/bin/env bash
# Host orchestrator; every build/test runs inside Docker. Invoke via sg docker.
set -euo pipefail
source_commit=$(git rev-parse HEAD)
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]]
client_commit=4500c233e38fbdc2db5932f5edbe92f4fdd1ab9c
image="anet-test883:${source_commit}"
run_prefix="test883-${source_commit:0:12}-${RANDOM}"
artifact_dir="${ARTIFACT_DIR:-/tmp/test883-${source_commit:0:12}}"
mkdir -p "$artifact_dir"
# Only tracked bytes from the recorded commit, not the developer's worktree.
git archive "$source_commit" | docker build --build-arg SOURCE_COMMIT="$source_commit" -t "$image" -f tests/test883-v2-portable-client/Dockerfile -
docker image inspect "$image" --format '{{.Id}}' | tee "$artifact_dir/image-id.txt"
run_case() {
  local name="$1" wrong="$2" rc=0
  docker run --name "$run_prefix-$name" --init --network none --shm-size=256m \
    -e EXPECTED_SOURCE_COMMIT="$source_commit" -e EXPECTED_CLIENT_SOURCE_COMMIT="$client_commit" \
    -e TEST829_WRONG_PROVIDER_EXPECTATION="$wrong" "$image" >"$artifact_dir/$name.log" 2>&1 || rc=$?
  cat "$artifact_dir/$name.log"
  mkdir -p "$artifact_dir/$name"
  docker cp "$run_prefix-$name:/artifacts/." "$artifact_dir/$name/"
  docker rm "$run_prefix-$name" >/dev/null
  if [[ "$name" = positive ]]; then
    test "$rc" = 0
    grep -Fq 'PASS actual daemon stop/start task chain; rendered lifecycle UI=true' "$artifact_dir/$name.log"
    grep -Fq 'PASS: owned harness processes exited' "$artifact_dir/$name.log"
  else
    test "$rc" = 1
    grep -Fq 'FAIL: post-change task reached new provider model only' "$artifact_dir/$name.log"
    ! grep -Fq 'L5 actual daemon stop/start lifecycle' "$artifact_dir/$name.log"
    grep -Fq 'PASS: owned harness processes exited' "$artifact_dir/$name.log"
  fi
}
run_case positive 0
run_case wrong-model 1
echo 'PASS test883 cold-source build, real-client lifecycle, wrong-model negative control'
