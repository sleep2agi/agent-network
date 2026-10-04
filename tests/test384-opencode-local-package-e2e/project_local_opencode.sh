#!/bin/sh
set -eu

: > /tmp/test384/project-local-opencode-was-executed
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' '1.18.34'
  exit 0
fi
exit 93
