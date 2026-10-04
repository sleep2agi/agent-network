FROM oven/bun:1.3.14

# bsdutils: `script` gives case T a pseudo-terminal for the interactive picker.
RUN apt-get update && apt-get install -y --no-install-recommends bsdutils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY server/package.json server/package-lock.json ./server/
RUN cd server && bun install --frozen-lockfile --ignore-scripts

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY server ./server
COPY agent-network ./agent-network
COPY tests/test528-codex-adopt ./tests/test528-codex-adopt
COPY tests/lib/safe-rm.sh ./tests/lib/safe-rm.sh

ARG SOURCE_COMMIT
ENV TEST528_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test528-codex-adopt/run.sh
ENTRYPOINT ["/workspace/tests/test528-codex-adopt/run.sh"]
