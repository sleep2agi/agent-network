FROM oven/bun:1.3.14

WORKDIR /workspace
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY server/package.json ./server/
RUN cd server && bun install --ignore-scripts
COPY server ./server

COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && bun install --ignore-scripts
COPY agent-network ./agent-network
COPY tests/test625-explicit-env-crlf ./tests/test625-explicit-env-crlf

ARG SOURCE_COMMIT
ENV TEST625_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 tests/test625-explicit-env-crlf/run.sh tests/test625-explicit-env-crlf/fake-agent-node.sh
ENTRYPOINT ["/workspace/tests/test625-explicit-env-crlf/run.sh"]
