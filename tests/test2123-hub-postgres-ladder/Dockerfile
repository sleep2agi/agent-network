FROM oven/bun:1.3.14

# Postgres runs inside this same container (one Dockerfile per suite, no
# compose). The Hub talks to it with Bun's built-in SQL client — no node, no
# pg package — so a missing driver cannot hide behind the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work/server
COPY server/package.json ./package.json
RUN bun install
COPY server/src ./src
COPY tests/test601-hub-scheduled-tasks/race-worker.ts /work/tests/test601-hub-scheduled-tasks/race-worker.ts
COPY tests/test2123-hub-postgres-ladder /work/tests/test2123-hub-postgres-ladder
RUN chmod +x /work/tests/test2123-hub-postgres-ladder/run.sh

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT
CMD ["bash", "/work/tests/test2123-hub-postgres-ladder/run.sh"]
