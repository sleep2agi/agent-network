FROM oven/bun:1.3.14

WORKDIR /work/server
COPY server/package.json server/package-lock.json ./
RUN bun install --frozen-lockfile
COPY server/src ./src
COPY server/bin ./bin
COPY tests/test-req-abandoned-column /work/tests/test-req-abandoned-column
COPY tests/test584-dashboard-codex-delivery/mutate.ts /work/tests/mutate.ts
RUN chmod +x /work/tests/test-req-abandoned-column/run.sh

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["/work/tests/test-req-abandoned-column/run.sh"]
