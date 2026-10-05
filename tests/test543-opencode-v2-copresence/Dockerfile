# #543 — OpenCode V2 (@opencode/cli) co-presence preview, real binary + loopback stub model.
FROM oven/bun:1.3.1

ARG OPENCODE_V2_VERSION=2.0.22
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl jq nodejs npm procps python3 tmux && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g "@opencode/cli@${OPENCODE_V2_VERSION}" --silent && \
    test "$(opencode --version)" = "opencode v${OPENCODE_V2_VERSION}"

COPY agent-node/package.json agent-node/package-lock.json /agent-node-src/
RUN cd /agent-node-src && npm ci --ignore-scripts --no-audit --no-fund --silent
COPY agent-node /agent-node-src
COPY tests/test543-opencode-v2-copresence/ /test543/
RUN chmod +x /test543/run.sh /test543/stub-model.py

ENV OPENCODE_V2_VERSION_UNDER_TEST=${OPENCODE_V2_VERSION}
WORKDIR /test543
CMD ["bash", "/test543/run.sh"]
