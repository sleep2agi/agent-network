ARG SOURCE_COMMIT
FROM oven/bun:1.3.14

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts
COPY agent-node/src ./agent-node/src
COPY server/src ./server/src
COPY tests/test584-dashboard-codex-delivery/run.sh /harness/run.sh
COPY tests/test584-dashboard-codex-delivery/mutate.ts /harness/mutate.ts
RUN chmod 0755 /harness/run.sh

ARG SOURCE_COMMIT
ENV TEST584_SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["/harness/run.sh"]
