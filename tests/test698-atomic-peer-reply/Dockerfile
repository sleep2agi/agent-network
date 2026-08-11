FROM oven/bun:1.3.14

WORKDIR /workspace

COPY server/package.json server/bun.lock* ./server/
RUN cd server && bun install --ignore-scripts

COPY agent-node/package.json ./agent-node/
RUN cd agent-node && bun install --ignore-scripts

COPY server ./server
COPY agent-node ./agent-node
COPY tests/test698-atomic-peer-reply ./tests/test698-atomic-peer-reply
COPY tests/test673-claude-image-attachment-block/sdk-stub-preload.ts ./tests/test698-atomic-peer-reply/sdk-stub-preload.ts

ARG SOURCE_COMMIT
ENV TEST698_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test698-atomic-peer-reply/run.sh
ENTRYPOINT ["/workspace/tests/test698-atomic-peer-reply/run.sh"]
