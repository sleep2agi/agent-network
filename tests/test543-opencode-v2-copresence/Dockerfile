# #543 — OpenCode V2 (@opencode/cli) co-presence preview, real binary + loopback stub model.
FROM oven/bun:1.3.1

# Not an ARG: the qa.yml matrix step passes $GITHUB_SHA into every `^ARG` it finds in a suite Dockerfile,
# which turned this into `@opencode/cli@<sha>` (npm ETARGET) on CI only.
ENV OPENCODE_V2_VERSION=2.0.22
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl jq nodejs npm procps python3 tmux && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g "@opencode/cli@${OPENCODE_V2_VERSION}" --no-audit --no-fund \
      --fetch-retries=5 --fetch-retry-mintimeout=5000 --fetch-retry-maxtimeout=60000 && \
    v="$(opencode --version)" && echo "installed: $v" && \
    { [ "$v" = "opencode v${OPENCODE_V2_VERSION}" ] || { echo "expected opencode v${OPENCODE_V2_VERSION}, got: $v" >&2; exit 1; }; }

COPY agent-node/package.json agent-node/package-lock.json /agent-node-src/
RUN cd /agent-node-src && npm ci --ignore-scripts --no-audit --no-fund --silent
COPY agent-node /agent-node-src
COPY tests/test543-opencode-v2-copresence/ /test543/
RUN chmod +x /test543/run.sh /test543/stub-model.py

ENV OPENCODE_V2_VERSION_UNDER_TEST=${OPENCODE_V2_VERSION}
WORKDIR /test543
CMD ["bash", "/test543/run.sh"]
