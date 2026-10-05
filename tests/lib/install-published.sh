#!/usr/bin/env bash
# tests/lib/install-published.sh — install a PUBLISHED @sleep2agi/* package by a moving dist-tag
# (@preview / @latest) without tripping over the just-published window. Source it; don't run it.
#
# install_published <pkg> <dist-tag> <logfile>
#   Resolves <dist-tag> to an exact version, waits until that version's tarball is actually
#   fetchable from the registry, then installs exactly that version (`npm install -g pkg@X.Y.Z`).
#   Sets INSTALLED_VERSION. On failure it prints a `FAIL:` line plus the tail of <logfile> and
#   returns 1 — it never fails silently (callers run under `set -e`, so that ends the suite).
#
# Usage in a suite (Docker build context = repo root, run.sh at /app/run.sh):
#   Dockerfile:  COPY tests/lib/install-published.sh /lib/install-published.sh
#   run.sh:      source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/install-published.sh"
#                install_published @sleep2agi/agent-network preview /tmp/npm-install.log
#
# WHY (2026-10-05, #2391 → #564): suites install the MOVING `@preview` tag from the live registry,
# and release.yml publishes into that tag. Right after a publish the tag already points at the new
# version but its tarball is not servable yet (observed 25–95 s); npm does not retry a 404, and the
# old `npm install -g …@preview >/tmp/npm-install.log 2>&1` under `set -e` exited 1 with ZERO
# output. test30 (#2391) and then ~15 L1 suites (#2385/#2389) went red in batches that way; reruns
# minutes later passed. tests/lib/install-published.test.sh reproduces the window against a local
# fake registry (install-published-fake-registry.mjs).
#
# Knobs: PUBLISH_WAIT_S (default 600 = the 10 min cap) total wait for the tarball;
#        PUBLISH_POLL_S (default 15) poll interval.

install_published() {
  local pkg=$1 tag=$2 log=$3 v="" tb="" now deadline
  deadline=$(( $(date +%s) + ${PUBLISH_WAIT_S:-600} ))
  INSTALLED_VERSION=""
  : >> "$log"
  while :; do
    v=$(npm view "$pkg@$tag" version --prefer-online 2>>"$log") || v=""
    tb=""
    if [ -n "$v" ]; then
      tb=$(npm view "$pkg@$v" dist.tarball --prefer-online 2>>"$log") || tb=""
      if [ -n "$tb" ] && curl -fsSL -o /dev/null "$tb" 2>>"$log"; then
        break
      fi
    fi
    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
      echo "FAIL: $pkg@$tag → ${v:-<unresolved>}: tarball ${tb:-<none>} still not fetchable after ${PUBLISH_WAIT_S:-600}s"
      echo "--- tail of $log ---"; tail -n 40 "$log" || true
      return 1
    fi
    echo "  waiting: $pkg@$tag → ${v:-<unresolved>} tarball not fetchable yet (just published?) — retry in ${PUBLISH_POLL_S:-15}s"
    sleep "${PUBLISH_POLL_S:-15}"
  done
  if ! npm install -g "$pkg@$v" --prefer-online >>"$log" 2>&1; then
    echo "FAIL: npm install -g $pkg@$v (resolved from @$tag)"
    echo "--- tail of $log ---"; tail -n 40 "$log" || true
    return 1
  fi
  INSTALLED_VERSION=$v
  echo "  installed $pkg@$v (from @$tag)"
}
