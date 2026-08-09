FROM oven/bun:1.3.14

WORKDIR /workspace

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY tests/test611-cli-boolean-flags ./tests/test611-cli-boolean-flags

ARG SOURCE_COMMIT
ENV TEST611_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test611-cli-boolean-flags/run.sh
ENTRYPOINT ["/workspace/tests/test611-cli-boolean-flags/run.sh"]
