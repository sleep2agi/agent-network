FROM oven/bun:1.3.14-debian
WORKDIR /app
COPY server/src/db-adapter.ts ./server/src/db-adapter.ts
COPY server/src/side-thread.ts ./server/src/side-thread.ts
COPY server/src/side-thread-http.ts ./server/src/side-thread-http.ts
COPY contracts/side-thread/v1 ./contracts/side-thread/v1
COPY tests/test1199-btw-cross-layer-contract ./tests/test1199-btw-cross-layer-contract
RUN chmod +x ./tests/test1199-btw-cross-layer-contract/run.sh
CMD ["./tests/test1199-btw-cross-layer-contract/run.sh"]
