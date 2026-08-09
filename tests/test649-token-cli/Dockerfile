FROM oven/bun:1.3.14

WORKDIR /workspace

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY tests/lib ./tests/lib
COPY tests/test649-token-cli ./tests/test649-token-cli

ARG TEST649_SOURCE_COMMIT=unknown
ENV TEST649_SOURCE_COMMIT=$TEST649_SOURCE_COMMIT
RUN chmod 0755 /workspace/tests/test649-token-cli/run.sh
ENTRYPOINT ["/workspace/tests/test649-token-cli/run.sh"]
