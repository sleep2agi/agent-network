FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /repo/server
COPY server/package.json server/package-lock.json ./
RUN bun install --frozen-lockfile --ignore-scripts
RUN ln -s /repo/server/node_modules /repo/node_modules
WORKDIR /repo/agent-node
COPY agent-node/package.json agent-node/package-lock.json ./
RUN bun install --frozen-lockfile --ignore-scripts
WORKDIR /repo/server
COPY server/src ./src
COPY agent-node/src /repo/agent-node/src
COPY tests/test1163-human-inbox /repo/tests/test1163-human-inbox
ARG SOURCE_COMMIT=local
ENV SOURCE_COMMIT=$SOURCE_COMMIT
CMD ["bash","/repo/tests/test1163-human-inbox/run.sh"]
