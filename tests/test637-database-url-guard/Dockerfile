FROM oven/bun:1.3.14

RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs strace \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work
COPY tests/test637-database-url-guard/package.json ./package.json
RUN bun install --production
COPY server/src ./server/src
COPY tests/test637-database-url-guard ./tests/test637-database-url-guard

ARG TEST637_SOURCE_COMMIT=unknown
ENV TEST637_SOURCE_COMMIT=$TEST637_SOURCE_COMMIT
RUN chmod 0755 tests/test637-database-url-guard/run.sh
ENTRYPOINT ["tests/test637-database-url-guard/run.sh"]
