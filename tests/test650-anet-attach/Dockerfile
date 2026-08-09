FROM oven/bun:1.3.14
WORKDIR /workspace
COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts
COPY agent-network ./agent-network
COPY tests/lib ./tests/lib
COPY tests/test650-anet-attach ./tests/test650-anet-attach
ARG TEST650_SOURCE_COMMIT=unknown
ENV TEST650_SOURCE_COMMIT=$TEST650_SOURCE_COMMIT
RUN chmod 0755 tests/test650-anet-attach/run.sh tests/test650-anet-attach/fake-bin/tmux
ENTRYPOINT ["/workspace/tests/test650-anet-attach/run.sh"]
