ARG SOURCE_COMMIT
FROM oven/bun:1.3.14

RUN apt-get update && apt-get install -y --no-install-recommends tmux curl procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts
COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts
COPY agent-node ./agent-node
COPY agent-network ./agent-network
COPY server ./server
COPY tests/test751-codex-copresence-windows ./tests/test751-codex-copresence-windows
COPY tests/test1191-windows-steer-contract/linux-e2e.mjs /linux-e2e.mjs
COPY tests/test1191-windows-steer-contract/run.sh /run.sh
COPY tests/test584-dashboard-codex-delivery/mutate.ts /mutate.ts
RUN chmod 0755 /run.sh

ARG SOURCE_COMMIT
ENV TEST1191_SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["/run.sh"]
