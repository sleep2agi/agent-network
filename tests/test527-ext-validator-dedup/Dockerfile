FROM oven/bun:1.3.14

WORKDIR /workspace

COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts

COPY server ./server
COPY tests/test527-ext-validator-dedup ./tests/test527-ext-validator-dedup

ARG SOURCE_COMMIT
ENV TEST527_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test527-ext-validator-dedup/run.sh
ENTRYPOINT ["/workspace/tests/test527-ext-validator-dedup/run.sh"]
