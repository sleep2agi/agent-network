FROM oven/bun:1.3.14

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY agent-node ./agent-node
COPY agent-network/src/grok-attach-client.ts ./agent-network/src/grok-attach-client.ts
COPY tests/test520-task-runtime-evidence ./tests/test520-task-runtime-evidence

ARG TEST520_SOURCE_COMMIT=uncommitted
ENV TEST520_SOURCE_COMMIT=$TEST520_SOURCE_COMMIT
RUN chmod 0755 tests/test520-task-runtime-evidence/run.sh

ENTRYPOINT ["/workspace/tests/test520-task-runtime-evidence/run.sh"]
