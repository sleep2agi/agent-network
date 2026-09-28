#!/usr/bin/env bash
set -euo pipefail
cd "$(mktemp -d)"
git init -q --bare remote.git
git init -q -b main source
cd source
git config user.name fixture
git config user.email fixture@example.invalid
git commit -q --allow-empty -m base
base=$(git rev-parse HEAD)
git remote add origin ../remote.git
git push -q origin main
export PUBLISH=true RELEASE_COMMIT="$base"
bash /guard.sh
reject() {
  if bash /guard.sh; then echo "FAIL: accepted $1"; exit 1; fi
  echo "PASS: rejected $1"
}
RELEASE_COMMIT='' reject missing
RELEASE_COMMIT="${base:0:8}" reject short
RELEASE_COMMIT=main reject branch
git checkout -q -b feature
git commit -q --allow-empty -m feature
feature=$(git rev-parse HEAD)
RELEASE_COMMIT="$base" reject wrong-head
RELEASE_COMMIT="$feature" reject unmerged
PUBLISH=false RELEASE_COMMIT='' bash /guard.sh
git checkout -q main
git commit -q --allow-empty -m advance
git push -q origin main
git checkout -q "$base"
RELEASE_COMMIT="$base" bash /guard.sh
echo 'PASS: main ancestor accepted; nonpublishing feature run allowed'
