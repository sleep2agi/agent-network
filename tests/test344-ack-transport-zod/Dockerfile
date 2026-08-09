FROM oven/bun:1.3.14

WORKDIR /workspace

COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts

COPY server ./server
COPY tests/test344-ack-transport-zod ./tests/test344-ack-transport-zod

ARG SOURCE_COMMIT
ENV TEST344_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test344-ack-transport-zod/run.sh
ENTRYPOINT ["/workspace/tests/test344-ack-transport-zod/run.sh"]
