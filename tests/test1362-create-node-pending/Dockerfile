FROM oven/bun:1.3.14

WORKDIR /workspace

COPY server/package.json server/package-lock.json ./server/
RUN cd /workspace/server && bun install --ignore-scripts

COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
RUN cd /workspace/agent-node && bun install --ignore-scripts

COPY server ./server
COPY agent-node ./agent-node
COPY tests/test629-mcp-schema-policy ./tests/test629-mcp-schema-policy
COPY tests/test1362-create-node-pending/run.sh ./tests/test1362-create-node-pending/run.sh
RUN chmod 0755 ./tests/test1362-create-node-pending/run.sh

ARG SOURCE_COMMIT=unknown
ENV TEST1362_SOURCE_COMMIT=${SOURCE_COMMIT}

CMD ["./tests/test1362-create-node-pending/run.sh"]
