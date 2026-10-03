FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

WORKDIR /workspace
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY server/package.json ./server/
RUN cd server && bun install --ignore-scripts
COPY server ./server

COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && bun install --ignore-scripts
COPY agent-network ./agent-network
COPY tests/test509-node-clone ./tests/test509-node-clone

ARG SOURCE_COMMIT
ENV TEST509_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 tests/test509-node-clone/run.sh
ENTRYPOINT ["/workspace/tests/test509-node-clone/run.sh"]
