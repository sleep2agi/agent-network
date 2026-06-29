# RFC-027 PR1.2 — stop/delete node lifecycle Docker e2e.
# Spawns a real hub + a real host_supervisor daemon + drives the MCP
# stop_node / delete_node tools end-to-end with REAL process lifecycle
# verification (pgrep before/after, chmod 700 on backup dir, sweeper
# real-delete). Preview gate per 通信龙 2026-06-30 ack of PR #348.
#
# Install path identical to qa-rfc026 (LOCAL source, not npm @preview).
# Bookworm-slim + bun + build-essential + python3 (node-pty native gyp).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq unzip procps \
    build-essential python3 \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

COPY server /app/server
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network
COPY tests/lib /app/tests/lib
COPY tests/qa-rfc027-stop-delete/run.sh /app/tests/qa-rfc027-stop-delete/run.sh
RUN chmod +x /app/tests/qa-rfc027-stop-delete/run.sh

RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent && bun run build
RUN cd /app/agent-network && bun install --silent && bun run build

RUN cd /app/agent-node \
    && npm pack \
    && npm install -g ./sleep2agi-agent-node-*.tgz
RUN cd /app/agent-network \
    && npm pack \
    && npm install -g ./sleep2agi-agent-network-*.tgz

RUN anet --version && which anet && which agent-node

CMD ["/app/tests/qa-rfc027-stop-delete/run.sh"]
