FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates jq && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN bun install --frozen-lockfile
COPY server/src ./src

WORKDIR /app
COPY tests/qa-hub-16-rest-task-api/run.sh /app/run.sh
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
RUN chmod +x /app/run.sh
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
RUN mkdir -p /app/docs/tests && chown -R bun:bun /app
USER bun

CMD ["/app/run.sh"]
