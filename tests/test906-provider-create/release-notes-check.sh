#!/bin/sh
# TEST ONLY: the formal release.yml Gate 3 file-source contract, no publication.
set -eu
for version in 2.3.0-preview.166 2.5.0-preview.132 0.9.0-preview.124; do
  notes_file="/candidate/docs/tests/release-v${version}.md"
  test -f "$notes_file"
  grep -qE '^## Install\b' "$notes_file"
  grep -qE '^## Upgrade\b' "$notes_file"
  install_block=$(awk '
    found && /^## / { exit }
    /^## Install$/ { found=1 }
    found { print }
  ' "$notes_file" | head -50)
  printf '%s\n' "$install_block" | grep -qE "@${version}\b"
  printf 'PASS release notes: %s exact Install + Upgrade\n' "$version"
done
