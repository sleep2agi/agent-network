FROM oven/bun:1.3.14

WORKDIR /workspace

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY tests/lib ./tests/lib
COPY tests/test651-init-no-token-prompt ./tests/test651-init-no-token-prompt

ARG TEST651_SOURCE_COMMIT=unknown
ENV TEST651_SOURCE_COMMIT=$TEST651_SOURCE_COMMIT
RUN chmod 0755 /workspace/tests/test651-init-no-token-prompt/run.sh
ENTRYPOINT ["/workspace/tests/test651-init-no-token-prompt/run.sh"]
