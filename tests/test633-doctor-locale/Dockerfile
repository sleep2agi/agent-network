FROM oven/bun:1.3.14

WORKDIR /workspace

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY tests/lib ./tests/lib
COPY tests/test633-doctor-locale ./tests/test633-doctor-locale

ARG SOURCE_COMMIT
ENV TEST633_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test633-doctor-locale/run.sh
ENTRYPOINT ["/workspace/tests/test633-doctor-locale/run.sh"]
