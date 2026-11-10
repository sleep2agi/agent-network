FROM oven/bun:1.3.14-debian
ARG SOURCE_COMMIT=dev
ENV SOURCE_COMMIT=$SOURCE_COMMIT
WORKDIR /app
COPY server/src/db-adapter.ts ./server/src/db-adapter.ts
COPY server/src/side-thread.ts ./server/src/side-thread.ts
COPY server/src/side-thread-http.ts ./server/src/side-thread-http.ts
COPY contracts ./contracts
# contracts/*.ts re-export ../server/src/contracts/*
COPY server/src/contracts ./server/src/contracts
COPY tests/test1199-btw-cross-layer-contract ./tests/test1199-btw-cross-layer-contract
RUN chmod +x ./tests/test1199-btw-cross-layer-contract/run.sh
CMD ["./tests/test1199-btw-cross-layer-contract/run.sh"]
