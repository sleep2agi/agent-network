FROM oven/bun:1

WORKDIR /app
COPY server/package.json server/package.json
COPY server/src/ server/src/
ENV COMMHUB_DB=/tmp/qa-ut-03.db

CMD ["bun", "test", "server/src/auth-validate.test.ts"]
