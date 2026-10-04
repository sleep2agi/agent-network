FROM oven/bun:1.3.14

# tmux: the co-presence-like sessions in case C (on a private -L socket).
# procps: `anet node stop` (which delete now runs) reads the process table with ps.
RUN apt-get update && apt-get install -y --no-install-recommends tmux procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY server/package.json server/package-lock.json ./server/
RUN cd server && bun install --frozen-lockfile --ignore-scripts

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY server ./server
COPY agent-network ./agent-network
COPY tests/test522-node-delete-locate-stop ./tests/test522-node-delete-locate-stop
COPY tests/lib/safe-rm.sh ./tests/lib/safe-rm.sh

ARG SOURCE_COMMIT
ENV TEST522_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test522-node-delete-locate-stop/run.sh
ENTRYPOINT ["/workspace/tests/test522-node-delete-locate-stop/run.sh"]
