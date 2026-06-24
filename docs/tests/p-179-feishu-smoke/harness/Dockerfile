FROM oven/bun:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq sqlite3 procps unzip git python3 make g++ \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Clone PR branch (feat/179-feishu-agent-sdk-channel) shallow
WORKDIR /src
RUN git clone --depth 1 --branch feat/179-feishu-agent-sdk-channel \
    https://github.com/sleep2agi/agent-network.git . && \
    git log --oneline -3

# Install agent-network + agent-node deps. Use --no-postinstall to skip
# native node-pty build (we don't need TTY for these IPC smoke tests).
RUN cd /src/agent-network && bun install --silent --ignore-scripts
RUN cd /src/agent-node && bun install --silent --ignore-scripts

# Lark SDK is the feishu adapter's only hard dep
RUN cd /src/agent-network && bun add @larksuiteoapi/node-sdk --ignore-scripts 2>&1 | tail -3 || true

COPY entry.sh /entry.sh
COPY ipc-roundtrip-test.mjs /ipc-roundtrip-test.mjs
COPY ipc-stub-child.mjs /ipc-stub-child.mjs
RUN chmod +x /entry.sh

RUN mkdir -p /artifacts && chmod 0777 /artifacts
WORKDIR /work
ENV COMMHUB_DB=/tmp/feishu-smoke-commhub.db
CMD ["/entry.sh"]
