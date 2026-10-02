FROM oven/bun:1.3.14

WORKDIR /work/server
COPY server/package.json ./package.json
RUN bun install
COPY server/src ./src
COPY server/bin ./bin
COPY tests/test-status-read-cache /work/tests/test-status-read-cache
COPY tests/test584-dashboard-codex-delivery/mutate.ts /work/tests/mutate.ts
RUN chmod +x /work/tests/test-status-read-cache/run.sh

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["/work/tests/test-status-read-cache/run.sh"]
