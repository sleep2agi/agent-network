#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$REPO_ROOT/tests/lib/safe-rm.sh"

candidate="${1:-}"
if [[ -z "$candidate" ]]; then
  echo "usage: $0 /absolute/path/to/clean-candidate-worktree" >&2
  exit 2
fi
candidate="$(cd "$candidate" && pwd)"

if [[ -n "$(git -C "$candidate" status --porcelain)" ]]; then
  echo "FAIL: candidate worktree is dirty: $candidate" >&2
  exit 2
fi

expected="$(git -C "$candidate" rev-parse --verify HEAD)"
if [[ ! "$expected" =~ ^[0-9a-f]{40}$ ]]; then
  echo "FAIL: candidate HEAD is not a full commit SHA: $expected" >&2
  exit 2
fi

archive_dir="$(mktemp -d /tmp/anet-test537-candidate.XXXXXX)"
cleanup() {
  safe_rm_rf "$archive_dir"
}
trap cleanup EXIT

git -C "$candidate" archive --format=tar HEAD -- \
  docs/tests/report-test219.txt \
  docs/tests/report-test224.txt \
  docs/tests/report-test225.txt \
  tests/test225-grok-preview-package-live/source-commit.txt \
  | tar -xf - -C "$archive_dir"

echo "candidate_worktree=$candidate"
echo "candidate_commit=$expected"
df -h / | tail -n 1

export TEST537_ARCHIVE_DIR="$archive_dir"
export TEST537_EXPECTED="$expected"
export TEST537_REPO_ROOT="$REPO_ROOT"
export TEST537_IMAGE_TAG="anet-test537-grok-tui-provenance:dev"

sg docker -c 'docker build \
  --build-context "candidate=$TEST537_ARCHIVE_DIR" \
  -t "$TEST537_IMAGE_TAG" \
  -f "$TEST537_REPO_ROOT/tests/test537-grok-tui-provenance/Dockerfile" \
  "$TEST537_REPO_ROOT"'

image_id="$(
  sg docker -c 'docker image inspect --format "{{.Id}}" "$TEST537_IMAGE_TAG"'
)"
if [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "FAIL: built image returned an invalid immutable id: $image_id" >&2
  exit 2
fi
printf 'image_tag=%s\n' "$TEST537_IMAGE_TAG"
printf 'image_id=%s\n' "$image_id"

sg docker -c 'docker run --rm \
  --read-only \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  -e "EXPECTED_SOURCE_COMMIT=$TEST537_EXPECTED" \
  "$TEST537_IMAGE_TAG"'
