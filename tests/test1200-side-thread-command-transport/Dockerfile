FROM oven/bun:1.3.14-debian

WORKDIR /app
ARG TEST1200_SOURCE_COMMIT=unknown
ENV TEST1200_SOURCE_COMMIT=${TEST1200_SOURCE_COMMIT}

COPY agent-node/src/runtime/side-thread /app/agent-node/src/runtime/side-thread
COPY server/src/db-adapter.ts server/src/side-thread.ts server/src/side-thread-command-transport.ts server/src/side-thread-command-transport.test.ts /app/server/src/
COPY tests/test1200-side-thread-command-transport /app/tests/test1200-side-thread-command-transport
RUN chmod +x /app/tests/test1200-side-thread-command-transport/run.sh

CMD ["/app/tests/test1200-side-thread-command-transport/run.sh"]
