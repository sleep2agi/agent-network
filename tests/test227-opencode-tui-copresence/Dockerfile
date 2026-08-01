FROM oven/bun:1.3.1

ARG OPENCODE_VERSION=1.18.1
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl jq nodejs npm procps tmux && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g "opencode-ai@${OPENCODE_VERSION}" --silent && \
    test "$(opencode --version)" = "$OPENCODE_VERSION"

WORKDIR /test227
COPY agent-node /agent-node-src
COPY agent-network /agent-network-src
COPY tests/test227-opencode-tui-copresence/harness.ts /test227/harness.ts
COPY tests/test227-opencode-tui-copresence/run.sh /test227/run.sh
RUN chmod +x /test227/run.sh

ENV OPENCODE_VERSION_UNDER_TEST=${OPENCODE_VERSION}
CMD ["bash", "/test227/run.sh"]
