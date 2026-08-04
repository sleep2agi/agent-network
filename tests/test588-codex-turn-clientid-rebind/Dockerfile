FROM oven/bun:1.3.14

ARG SOURCE_COMMIT=uncommitted
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
ENV ANET_TEST_SOURCE_COMMIT=$SOURCE_COMMIT

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY agent-node/src ./agent-node/src
COPY tests/test588-codex-turn-clientid-rebind/run.sh /harness/run.sh
COPY tests/test588-codex-turn-clientid-rebind/mutate.ts /harness/mutate.ts
RUN chmod 0755 /harness/run.sh

ENTRYPOINT ["/harness/run.sh"]
