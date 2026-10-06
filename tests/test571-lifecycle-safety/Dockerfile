# #571 — three lifecycle safety holes, end-to-end on real processes:
#   S1/S2  daemon stop must never SIGTERM a same-alias agent-node in another workdir/HOME
#   S3     hub stop_node refuses a hand-started node even when a daemon is named
#   S4     `anet project up` must not delete a live node's .pid and start a second copy
#   S6     `.hub-stopped` stays down: project up keeps its .pid, boot sweep does not
#          pass that alias to project up (board #628)
# Real hub (local server source, throwaway SQLite) + real host_supervisor daemon
# (`anet node start` of a hand-written host_supervisor config, same as
# qa-rfc027-stop-delete) + locally packed anet / agent-node on PATH.
FROM node:22-bookworm-slim
ENV npm_config_audit=false npm_config_fund=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq unzip procps tmux \
    build-essential python3 sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# bun pinned by version + sha256 (check-bun-install-pin). Literal values, not ARG:
# this suite takes no build argument except SOURCE_COMMIT.
ENV BUN_VERSION=1.3.14
RUN curl --fail --silent --show-error --location --retry 5 --retry-delay 5 --retry-all-errors \
      "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip" -o /tmp/bun.zip \
 && echo "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/bun.zip -d /tmp/bunx \
 && mkdir -p /root/.bun/bin \
 && mv /tmp/bunx/bun-linux-x64/bun /root/.bun/bin/bun \
 && chmod 0755 /root/.bun/bin/bun \
 && rm -rf /tmp/bun.zip /tmp/bunx
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

COPY server /app/server
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network

RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent && bun run build
RUN cd /app/agent-network && bun install --silent && bun run build

RUN cd /app/agent-node && npm pack && npm install -g ./sleep2agi-agent-node-*.tgz
RUN cd /app/agent-network && npm pack && npm install -g ./sleep2agi-agent-network-*.tgz

RUN anet --version && which anet && which agent-node

COPY tests/lib/safe-rm.sh /app/tests/lib/safe-rm.sh
COPY deploy/fleet/anet-nodes-boot.sh /app/deploy/fleet/anet-nodes-boot.sh
COPY tests/test571-lifecycle-safety/run.sh /app/tests/test571-lifecycle-safety/run.sh
RUN chmod +x /app/tests/test571-lifecycle-safety/run.sh

ARG SOURCE_COMMIT
ENV T571_SOURCE_COMMIT=$SOURCE_COMMIT

CMD ["/app/tests/test571-lifecycle-safety/run.sh"]
