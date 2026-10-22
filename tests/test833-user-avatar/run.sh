#!/usr/bin/env bash
set -euo pipefail
cd /work/server
export HOST=127.0.0.1 COMMHUB_UPLOADS_DIR=/tmp/test833-uploads
bun --version
COMMHUB_DB=/tmp/test833-migration.db bun test src/user-avatar-migration.test.ts
COMMHUB_DB=/tmp/test833-validation.db bun test src/avatar-validate.test.ts
COMMHUB_DB=/tmp/test833-http.db bun test src/user-avatar-http.test.ts
# #2055：上传/读取/限流/原子性主场景必须在这个 suite 里真跑。
COMMHUB_DB=/tmp/test833-upload.db bun test src/user-avatar-upload-http.test.ts
# Independent process and database for the existing identity/session regressions.
COMMHUB_DB=/tmp/test833-sessions.db bun test src/auth-sessions-http.test.ts
COMMHUB_DB=/tmp/test833-acl.db bun test src/agent-acl-http.test.ts
COMMHUB_DB=/tmp/test833-presence.db bun test src/member-presence-http.test.ts
