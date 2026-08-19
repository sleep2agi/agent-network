# #517 / PR #519 — MCP write-path network resolution Docker e2e.
#
# Unlike the unit suite (server/src/mcp-write-network-resolution.test.ts,
# which injects enforceUserId/enforceNetworkId straight into registerTools),
# this suite drives the REAL authenticated chain the codex review demanded:
#   /api/auth/register → /api/auth/login (utok_, current_network=null)
#   → POST /mcp (requireAuth → resolveRequestAuth → createServer)
# and asserts the single-network fallback, the precise denial taxonomy,
# and the deleted-network membership cleanup end-to-end.
#
# Server-only image: no agent-node/agent-network build needed — every
# scenario is curl against the hub. Base oven/bun:1 (cached locally).
FROM oven/bun:1

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq sqlite3 ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server /app/server
COPY tests/qa-517-mcp-write-scope/run.sh /app/tests/qa-517-mcp-write-scope/run.sh
RUN chmod +x /app/tests/qa-517-mcp-write-scope/run.sh

RUN cd /app/server && bun install --silent

ARG TEST517_SOURCE_COMMIT=dev
ENV TEST517_SOURCE_COMMIT=$TEST517_SOURCE_COMMIT

CMD ["/app/tests/qa-517-mcp-write-scope/run.sh"]
