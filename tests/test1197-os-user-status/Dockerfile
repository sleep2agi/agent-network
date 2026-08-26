FROM oven/bun:1.3.14
WORKDIR /work

COPY server/package.json server/package-lock.json ./server/
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd server && bun install --frozen-lockfile
RUN cd agent-node && bun install --frozen-lockfile
RUN cd agent-network && bun install --frozen-lockfile --ignore-scripts

COPY server ./server
COPY agent-node ./agent-node
COPY agent-network ./agent-network
COPY tests/test1197-os-user-status/run.sh ./tests/test1197-os-user-status/run.sh
COPY tests/lib/safe-rm.sh ./tests/lib/safe-rm.sh
COPY tests/test601-hub-scheduled-tasks ./tests/test601-hub-scheduled-tasks

CMD ["bash", "tests/test1197-os-user-status/run.sh"]
