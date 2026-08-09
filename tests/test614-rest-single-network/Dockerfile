FROM oven/bun:1.3.14

WORKDIR /workspace

COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts

COPY server ./server
COPY tests/test614-rest-single-network ./tests/test614-rest-single-network

ARG SOURCE_COMMIT
ENV TEST614_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test614-rest-single-network/run.sh
ENTRYPOINT ["/workspace/tests/test614-rest-single-network/run.sh"]
