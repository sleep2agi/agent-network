# `anet daemon` CLI end-to-end (issue #338 / RFC-026 P2 PR1).
# Mirrors qa-rfc026-create-node install pattern: glibc base + bun +
# build-essential + python3 + LOCAL source via `npm install -g`. Tests
# that a user can go from zero to a registered host_supervisor daemon
# WITHOUT manually editing any config.json.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq unzip procps \
    build-essential python3 sqlite3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

COPY server /app/server
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network
COPY tests/lib /app/tests/lib
COPY tests/qa-anet-daemon-cmd/run.sh /app/tests/qa-anet-daemon-cmd/run.sh
RUN chmod +x /app/tests/qa-anet-daemon-cmd/run.sh

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

CMD ["/app/tests/qa-anet-daemon-cmd/run.sh"]
