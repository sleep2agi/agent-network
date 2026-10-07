#!/bin/sh
# Docker-only test launcher: daemon minimalEnv intentionally drops ANET_*.
# Reapply the non-admission fixture policy at the child Node interpreter boundary.
# Resource admission itself remains covered by test612 without this launcher.
set -eu
export ANET_START_MEM_GATE=0
exec /usr/local/bin/node-with-start-gate "$@"
