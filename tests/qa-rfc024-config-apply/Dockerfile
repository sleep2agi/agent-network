# RFC-024 §7.2 — config-apply Docker e2e. Spawns a real hub (PR A) +
# real agent-node (PR B) in one container, drives the MCP tools as a
# mock dashboard would, and asserts the end-to-end mechanical shape.
#
# Bookworm (not alpine) — agent-node's claude-agent-sdk binary is glibc
# only (per the 2026-06-26 alpine catch). Bun installed via the standard
# installer; unzip needed by the bun installer per same incident.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq unzip procps \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Copy the local source trees from this branch so the test exercises the
# exact code under review (NOT a published npm tag). The hub side is
# `server/`, the node side is `agent-node/`, the CLI wizard is in
# `agent-network/bin/cli.ts` (we don't need that for this e2e —
# we drive `bun run agent-node/src/cli.ts` directly).
COPY server /app/server
COPY agent-node /app/agent-node
# Mirror the repo tree layout so the run.sh relative source-path
# `../lib/safe-rm.sh` resolves cleanly.
COPY tests/lib /app/tests/lib
COPY tests/qa-rfc024-config-apply/run.sh /app/tests/qa-rfc024-config-apply/run.sh
RUN chmod +x /app/tests/qa-rfc024-config-apply/run.sh

# Install bun deps so first-run isn't slow + caches into the image layer.
RUN cd /app/server && bun install --silent || true
RUN cd /app/agent-node && bun install --silent || true

CMD ["/app/tests/qa-rfc024-config-apply/run.sh"]
