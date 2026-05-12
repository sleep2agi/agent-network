FROM oven/bun:1

WORKDIR /app
COPY server/package.json server/package.json
COPY server/src/ server/src/
# COMMHUB_DB routes db.ts schema bootstrap to a throwaway file —
# we test only pure generators/hashers, never touch the DB.
ENV COMMHUB_DB=/tmp/qa-ut-01.db

CMD ["bun", "test", "server/src/auth-tokens.test.ts"]
