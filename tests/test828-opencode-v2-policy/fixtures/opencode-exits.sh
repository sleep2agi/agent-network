#!/bin/sh
# Negative control only: mount over the Docker opencode executable.
if [ "$1" = "--version" ]; then
  echo 'opencode v2.0.22'
  exit 0
fi
echo 'TEST828_EARLY_EXIT' >&2
exit 7
