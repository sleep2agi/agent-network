FROM oven/bun:1.3.14

WORKDIR /workspace

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY tests/test606-node-start-help ./tests/test606-node-start-help

ARG SOURCE_COMMIT
ENV TEST606_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test606-node-start-help/run.sh
ENTRYPOINT ["/workspace/tests/test606-node-start-help/run.sh"]
