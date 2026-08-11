FROM oven/bun:1.3.14

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl jq ripgrep \
  && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/bun.lock* ./server/
RUN cd server && bun install --ignore-scripts

COPY agent-network/package.json agent-network/bun.lock* ./agent-network/
RUN cd agent-network && bun install --ignore-scripts

COPY agent-node/package.json ./agent-node/
RUN cd agent-node && bun install --ignore-scripts

COPY server ./server
COPY agent-network ./agent-network
COPY agent-node ./agent-node
COPY docs ./docs
COPY docs-site/docs ./docs-site/docs
COPY tests/lib ./tests/lib
COPY tests/test697-codex-default-model ./tests/test697-codex-default-model

ARG SOURCE_COMMIT
ENV TEST697_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test697-codex-default-model/run.sh
ENTRYPOINT ["/workspace/tests/test697-codex-default-model/run.sh"]
