FROM oven/bun:1

WORKDIR /app
COPY server/package.json server/package.json
COPY server/src/password-dict.ts server/src/password-dict.ts
COPY server/src/password-dict.test.ts server/src/password-dict.test.ts

# bun test auto-discovers *.test.ts — no install needed because the test
# imports nothing outside the file pair.
CMD ["bun", "test", "server/src/password-dict.test.ts"]
