FROM oven/bun:1.3.14
WORKDIR /workspace

COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts

COPY server ./server
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY agent-node ./agent-node
COPY tests/test687-owner-gated-schedule-write-red ./tests/test687-owner-gated-schedule-write-red

ARG TEST687_SOURCE_COMMIT=uncommitted-red
ENV TEST687_SOURCE_COMMIT=$TEST687_SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test687-owner-gated-schedule-write-red/run.sh
ENTRYPOINT ["/workspace/tests/test687-owner-gated-schedule-write-red/run.sh"]

