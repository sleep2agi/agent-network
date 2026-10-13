#!/bin/bash
# Versioned #906 deployment profile. Installs no packages and changes no data.
# Keep the previous runtime directory for rollback; see README.md.
set -uo pipefail
# .131 exact main software; previous .130 v113 is retained for rollback.
export HUB_RUNTIME_DIR="${HUB_RUNTIME_DIR:-$HOME/.commhub/runtime-v114-preview131}"
# Preserve the feature already enabled on the target Hub; an explicit 0 wins.
export COMMHUB_ENABLE_SIDE_THREADS="${COMMHUB_ENABLE_SIDE_THREADS:-1}"
exec bash "${HUB_BASE_LAUNCHER:-$HOME/.local/bin/hub-daemon-base.sh}"
