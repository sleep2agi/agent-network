FROM oven/bun:1
WORKDIR /work/server
COPY server/package.json ./package.json
RUN bun install
COPY server/src ./src
COPY agent-node/src/shared /work/agent-node/src/shared
COPY tests/test583-dashboard-chat-idempotency/run.sh /work/run.sh
RUN chmod +x /work/run.sh
ARG TEST583_SOURCE_COMMIT=dev
ENV TEST583_SOURCE_COMMIT=$TEST583_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST583_SOURCE_COMMIT

CMD ["/work/run.sh"]
