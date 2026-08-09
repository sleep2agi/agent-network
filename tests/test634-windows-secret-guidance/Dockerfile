FROM oven/bun:1.3.14

WORKDIR /workspace

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY tests/test634-windows-secret-guidance ./tests/test634-windows-secret-guidance

ARG SOURCE_COMMIT
ENV TEST634_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test634-windows-secret-guidance/run.sh
ENTRYPOINT ["/workspace/tests/test634-windows-secret-guidance/run.sh"]
