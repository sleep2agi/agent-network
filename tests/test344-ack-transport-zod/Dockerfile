FROM oven/bun:1.3.14

WORKDIR /workspace

COPY server/package.json server/package-lock.json ./server/
RUN cd server && bun install --frozen-lockfile --ignore-scripts

COPY server ./server
COPY tests/test344-ack-transport-zod ./tests/test344-ack-transport-zod

ARG SOURCE_COMMIT
ENV TEST344_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test344-ack-transport-zod/run.sh
ENTRYPOINT ["/workspace/tests/test344-ack-transport-zod/run.sh"]
