#!/usr/bin/env bash
set -euo pipefail
cd /work/server
export HOST=127.0.0.1 COMMHUB_UPLOADS_DIR=/tmp/test833-uploads
bun --version
COMMHUB_DB=/tmp/test833-migration.db bun test src/user-avatar-migration.test.ts
COMMHUB_DB=/tmp/test833-validation.db bun test src/avatar-validate.test.ts
COMMHUB_DB=/tmp/test833-http.db bun test src/user-avatar-http.test.ts
# Independent process and database for the existing identity/session regressions.
COMMHUB_DB=/tmp/test833-sessions.db bun test src/auth-sessions-http.test.ts
