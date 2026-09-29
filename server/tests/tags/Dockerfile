FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN bun install
COPY server/ ./
CMD ["sh", "-c", "bun test src/requirements-http.test.ts && bun test src/requirements-upgrade-migration.test.ts && bun test src/requirements-mcp.test.ts"]
