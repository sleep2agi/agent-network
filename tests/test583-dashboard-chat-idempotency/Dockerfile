FROM oven/bun:1
WORKDIR /work/server
COPY server/package.json ./package.json
RUN bun install
COPY server/src ./src
COPY agent-node/src/shared /work/agent-node/src/shared
COPY tests/test583-dashboard-chat-idempotency/run.sh /work/run.sh
RUN chmod +x /work/run.sh
CMD ["/work/run.sh"]
