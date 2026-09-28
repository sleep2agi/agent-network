#!/usr/bin/env bash
set -euo pipefail
# Non-publishing runs remain available for feature-branch testing.
if [[ "${PUBLISH:-false}" != true ]]; then exit 0; fi
if [[ ! "${RELEASE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo '::error::Publishing requires an explicit full 40-character commit SHA' >&2
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$RELEASE_COMMIT" ]]; then
  echo '::error::Checked-out source differs from release commit' >&2
  exit 1
fi
git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
if ! git merge-base --is-ancestor "$RELEASE_COMMIT" refs/remotes/origin/main; then
  echo '::error::Release commit is not an ancestor of current main' >&2
  exit 1
fi
