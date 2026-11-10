FROM oven/bun:1.3.14-debian

WORKDIR /app
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
COPY server/src/db-adapter.ts /app/server/src/db-adapter.ts
COPY server/src/side-thread.ts /app/server/src/side-thread.ts
COPY server/src/side-thread-http.ts /app/server/src/side-thread-http.ts
COPY server/src/side-thread.test.ts /app/server/src/side-thread.test.ts
COPY contracts /app/contracts
# contracts/*.ts re-export ../server/src/contracts/*
COPY server/src/contracts /app/server/src/contracts
COPY tests/test1195-side-thread-hub-contract/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
