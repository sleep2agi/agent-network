FROM oven/bun:1.3.14

WORKDIR /workspace

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY tests/lib ./tests/lib
COPY tests/test608-claude-cli-dependency ./tests/test608-claude-cli-dependency

ARG SOURCE_COMMIT
ENV TEST608_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test608-claude-cli-dependency/run.sh
ENTRYPOINT ["/workspace/tests/test608-claude-cli-dependency/run.sh"]
