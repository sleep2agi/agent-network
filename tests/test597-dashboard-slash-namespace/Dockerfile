FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

WORKDIR /workspace

COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && bun install --ignore-scripts
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY agent-node ./agent-node
COPY server ./server
COPY tests/test597-dashboard-slash-namespace ./tests/test597-dashboard-slash-namespace

ARG SOURCE_COMMIT
ENV TEST597_SOURCE_COMMIT=$SOURCE_COMMIT
ENV TEST597_ROOT=/workspace
RUN chmod 0755 /workspace/tests/test597-dashboard-slash-namespace/run.sh
ENTRYPOINT ["/workspace/tests/test597-dashboard-slash-namespace/run.sh"]
