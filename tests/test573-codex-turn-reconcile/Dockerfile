ARG SOURCE_COMMIT
FROM oven/bun:1.3.14

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY agent-node/src ./agent-node/src
COPY tests/test573-codex-turn-reconcile/run.sh /harness/run.sh
COPY tests/test573-codex-turn-reconcile/run-mutation.sh /harness/run-mutation.sh
COPY tests/test573-codex-turn-reconcile/mutate.mjs /harness/mutate.mjs
RUN chmod 0755 /harness/run.sh /harness/run-mutation.sh

ARG SOURCE_COMMIT
ENV TEST573_SOURCE_COMMIT=$SOURCE_COMMIT

ENTRYPOINT ["/harness/run.sh"]
