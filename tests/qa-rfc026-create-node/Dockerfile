# RFC-026 P1 — create-node + host-daemon Docker e2e. Spawns a real
# hub + a real "daemon-role" agent-node + drives MCP `create_node` as
# a mock dashboard, then asserts the daemon forks a real child node
# that registers + reports. 6 scenarios: A real create / B role gate
# / C cross-tenant / D secret no-leak / E injection rejected /
# F max-children.
#
# Install path identical to qa-rfc024 (LOCAL source, not npm @preview).
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
COPY tests/qa-rfc026-create-node/run.sh /app/tests/qa-rfc026-create-node/run.sh
RUN chmod +x /app/tests/qa-rfc026-create-node/run.sh

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

CMD ["/app/tests/qa-rfc026-create-node/run.sh"]
