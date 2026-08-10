# test466 — real Codex co-presence identity teardown E2E.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl jq procps tmux util-linux unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Pin the real vendor binary.  The test wrapper below only adds a detached
# marker-bearing child; every app-server/TUI protocol operation is performed
# by this installed Codex binary.
RUN npm install -g --no-audit --no-fund @openai/codex@0.147.0

WORKDIR /app

COPY server /app/server
COPY agent-network /app/agent-network
COPY agent-node /app/agent-node
COPY tests/lib /app/tests/lib

RUN cd /app/server && bun install --silent
# node-pty is unrelated to the tmux-managed co-presence path under test.
# Keep its native postinstall out of this image, as the other CLI E2E suites do.
RUN cd /app/agent-network && bun install --silent --ignore-scripts
RUN cd /app/agent-node && bun install --silent --ignore-scripts
ARG TEST466_SOURCE_COMMIT=unknown
ENV TEST466_SOURCE_COMMIT=${TEST466_SOURCE_COMMIT}
COPY tests/test466-codex-copresence-p3 /app/tests/test466-codex-copresence-p3
RUN install -m 0755 /app/tests/test466-codex-copresence-p3/anet-local /usr/local/bin/anet \
    && install -m 0755 /app/tests/test466-codex-copresence-p3/agent-node-local /usr/local/bin/agent-node \
    && chmod +x /app/tests/test466-codex-copresence-p3/run.sh \
               /app/tests/test466-codex-copresence-p3/mutations.sh \
               /app/tests/test466-codex-copresence-p3/codex-marker-wrapper

ENV REPO=/app
CMD ["/app/tests/test466-codex-copresence-p3/run.sh"]
