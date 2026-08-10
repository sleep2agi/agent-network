FROM oven/bun:1.3.14
WORKDIR /workspace

COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts

COPY server ./server
COPY tests/test683-hub-lifecycle-watcher ./tests/test683-hub-lifecycle-watcher

ARG TEST683_SOURCE_COMMIT=uncommitted-red
ENV TEST683_SOURCE_COMMIT=$TEST683_SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test683-hub-lifecycle-watcher/run.sh
ENTRYPOINT ["/workspace/tests/test683-hub-lifecycle-watcher/run.sh"]
