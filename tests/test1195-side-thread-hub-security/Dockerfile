FROM oven/bun:1.3.14-debian

WORKDIR /app/server
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
COPY server/package.json server/package-lock.json ./
RUN bun install --frozen-lockfile
COPY server/src ./src

WORKDIR /app
COPY tests/test1195-side-thread-hub-security/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
