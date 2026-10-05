# tests/test30-v0.8-auth-deprecation/install-published.sh — sourced by run.sh and selftest.sh.
#
# install_published <pkg> <dist-tag> <logfile>
#   Resolves <dist-tag> to an exact version, waits until that version's tarball is actually
#   fetchable from the registry, then installs exactly that version. Sets INSTALLED_VERSION.
#   On failure it prints a FAIL line plus the tail of <logfile> — it never fails silently.
#
# WHY (2026-10-05): this suite installs the MOVING `@preview` tag from the live registry, and the
# release workflow publishes into that tag. Both "auth + secret hygiene" reds that day
# (qa runs 37261675109 / 37278291214) started their `npm install -g …@preview` 75–90 s after a
# preview publish (2.3.0-preview.139 at 04:08:39Z, .141 at 07:46:14Z): the tag already pointed at
# the new version but its tarball was not servable yet, npm does not retry a 404, and the old
# `npm install … >/tmp/npm-install.log 2>&1` under `set -e` exited 1 with ZERO output and no
# artifact. Reruns (minutes later) passed. tests/test30-…/selftest.sh reproduces that window
# against a local fake registry.
#
# Knobs: PUBLISH_WAIT_S (default 600) total wait for the tarball; PUBLISH_POLL_S (default 15).

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
