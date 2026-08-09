FROM oven/bun:1.3.14

WORKDIR /workspace

COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts

COPY agent-node ./agent-node
COPY tests/test632-honest-sse-recovery ./tests/test632-honest-sse-recovery

ARG SOURCE_COMMIT
ENV TEST632_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test632-honest-sse-recovery/run.sh
ENTRYPOINT ["/workspace/tests/test632-honest-sse-recovery/run.sh"]
