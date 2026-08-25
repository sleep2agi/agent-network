FROM oven/bun:1.3.14-debian

WORKDIR /app
ARG TEST1193_SOURCE_COMMIT=unknown
ENV TEST1193_SOURCE_COMMIT=${TEST1193_SOURCE_COMMIT}

COPY agent-node/src/runtime/side-thread /app/agent-node/src/runtime/side-thread
COPY tests/test1193-side-thread-contract /app/tests/test1193-side-thread-contract
RUN chmod +x /app/tests/test1193-side-thread-contract/run.sh

CMD ["/app/tests/test1193-side-thread-contract/run.sh"]
