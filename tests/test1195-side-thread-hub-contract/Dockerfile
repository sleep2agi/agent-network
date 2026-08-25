FROM oven/bun:1.3.14-debian

WORKDIR /app
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
COPY server/src/db-adapter.ts /app/server/src/db-adapter.ts
COPY server/src/side-thread.ts /app/server/src/side-thread.ts
COPY server/src/side-thread-http.ts /app/server/src/side-thread-http.ts
COPY server/src/side-thread.test.ts /app/server/src/side-thread.test.ts
COPY contracts/side-thread/v1/golden.json /app/contracts/side-thread/v1/golden.json
COPY contracts/side-thread/v1/schema.json /app/contracts/side-thread/v1/schema.json
COPY tests/test1195-side-thread-hub-contract/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
