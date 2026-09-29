FROM oven/bun:1.3.14

# Postgres runs inside this same container (one Dockerfile per suite, no
# compose). nodejs + pg are what the current PgAdapter spawns per statement.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work/server
COPY server/package.json ./package.json
RUN bun install
COPY tests/test2123-hub-postgres-ladder/package.json /work/pgdeps/package.json
RUN cd /work/pgdeps && bun install --production && cp -r node_modules/. /work/server/node_modules/
COPY server/src ./src
COPY tests/test2123-hub-postgres-ladder /work/tests/test2123-hub-postgres-ladder
RUN chmod +x /work/tests/test2123-hub-postgres-ladder/run.sh

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT
CMD ["bash", "/work/tests/test2123-hub-postgres-ladder/run.sh"]
