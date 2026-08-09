FROM oven/bun:1.3.14

WORKDIR /workspace

COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts

COPY server ./server
COPY tests/test615-network-name ./tests/test615-network-name

ARG SOURCE_COMMIT
ENV TEST615_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test615-network-name/run.sh
ENTRYPOINT ["/workspace/tests/test615-network-name/run.sh"]
