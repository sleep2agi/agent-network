#!/usr/bin/env bash
set -euo pipefail
unset TMUX TMUX_PANE
export ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
mkdir -p "$ARTIFACT_DIR"
exec > >(tee "$ARTIFACT_DIR/report-test828.txt") 2>&1
timeout 180s bun /test828/harness.ts
