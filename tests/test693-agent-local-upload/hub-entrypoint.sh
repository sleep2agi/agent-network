#!/usr/bin/env bash
set -euo pipefail
export COMMHUB_SERVER=1
export HOST=0.0.0.0
export PORT="${PORT:-9200}"
export COMMHUB_DB="${COMMHUB_DB:-/hub-data/commhub.db}"
export COMMHUB_UPLOADS_DIR="${COMMHUB_UPLOADS_DIR:-/hub-data/uploads}"
mkdir -p "$(dirname "$COMMHUB_DB")" "$COMMHUB_UPLOADS_DIR"
cd /workspace/server
exec bun src/index.ts
