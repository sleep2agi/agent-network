#!/bin/bash
set -euo pipefail
export COMMHUB_NODE_PERMISSIONS=enforce
export COMMHUB_DB=/tmp/permissions-pure.db
bun test server/src/permission-tightening.test.ts
export COMMHUB_DB=/tmp/permissions-http.db
bun test server/src/permissions-grants-http.test.ts
