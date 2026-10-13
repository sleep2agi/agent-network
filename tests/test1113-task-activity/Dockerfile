FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
RUN apt-get update && apt-get install -y --no-install-recommends postgresql && rm -rf /var/lib/apt/lists/*
WORKDIR /work/server
COPY server/package.json server/package-lock.json ./
RUN bun install --frozen-lockfile
COPY agent-node/package.json agent-node/package-lock.json /work/agent-node/
RUN cd /work/agent-node && bun install --frozen-lockfile --ignore-scripts
COPY server/src ./src
COPY server/bin ./bin
COPY agent-node/src /work/agent-node/src
COPY agent-network/package.json agent-network/package-lock.json /work/agent-network/
COPY agent-network/src /work/agent-network/src
COPY tests/test601-hub-scheduled-tasks /work/tests/test601-hub-scheduled-tasks
COPY tests/test1113-task-activity /work/tests/test1113-task-activity
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
CMD ["bash", "/work/tests/test1113-task-activity/run.sh"]
