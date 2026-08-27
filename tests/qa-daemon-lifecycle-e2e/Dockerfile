# Daemon full-chain lifecycle e2e — `anet daemon up` → create_node →
# update_node_config → restart_node → stop_node, on ONE child within ONE
# daemon lifetime. Fills the square qa-rfc024-config-apply explicitly
# left open ("that belongs in the longer-form QA" — it takes the `skip`
# branch because no live agent-node is running).
#
# Install pattern mirrors qa-anet-daemon-cmd: glibc base + bun +
# build-essential + python3, LOCAL source installed globally via npm pack
# so `anet` on PATH is the code under test, not a registry build.
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

RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent && bun run build
RUN cd /app/agent-network && bun install --silent && bun run build

RUN cd /app/agent-node && npm pack && npm install -g ./sleep2agi-agent-node-*.tgz
RUN cd /app/agent-network && npm pack && npm install -g ./sleep2agi-agent-network-*.tgz

# Fail the BUILD (not the run) if the binaries under test are missing.
RUN anet --version && which anet && which agent-node

# The test scripts go LAST on purpose: editing run.sh then rebuilds only
# these layers (seconds) instead of invalidating three bun installs.
COPY tests/lib /app/tests/lib
COPY tests/qa-daemon-lifecycle-e2e/run.sh /app/tests/qa-daemon-lifecycle-e2e/run.sh
RUN chmod +x /app/tests/qa-daemon-lifecycle-e2e/run.sh

# Provenance. scripts/qa.sh reads these ARG names out of this file (it does
# not derive them from the suite name), so they must be spelled exactly
# `SOURCE_COMMIT` / `RUNSH_BLOB`. Without them the suite would run with no
# binding between the image and the commit its report claims — and that
# failure is silent: the output looks completely normal.
ARG SOURCE_COMMIT
ARG RUNSH_BLOB
ENV DLIFE_SOURCE_COMMIT=$SOURCE_COMMIT
ENV DLIFE_RUNSH_BLOB=$RUNSH_BLOB

CMD ["/app/tests/qa-daemon-lifecycle-e2e/run.sh"]
