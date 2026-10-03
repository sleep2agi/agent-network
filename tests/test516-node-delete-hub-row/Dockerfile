FROM oven/bun:1.3.14

WORKDIR /workspace

COPY server/package.json server/package-lock.json ./server/
RUN cd server && bun install --frozen-lockfile --ignore-scripts

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY server ./server
COPY agent-network ./agent-network
COPY tests/test516-node-delete-hub-row ./tests/test516-node-delete-hub-row

ARG SOURCE_COMMIT
ENV TEST516D_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test516-node-delete-hub-row/run.sh
ENTRYPOINT ["/workspace/tests/test516-node-delete-hub-row/run.sh"]
