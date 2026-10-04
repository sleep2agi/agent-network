ARG SOURCE_COMMIT
FROM oven/bun:1.3.14

# tmux for the real co-presence launcher; procps for pgrep in the leftover check.
# No node/npx in this image on purpose: the suite puts a FAKE npx on PATH that
# serves the paired agent-node entrypoint after a configurable delay (#535 P1-1).
RUN apt-get update && apt-get install -y --no-install-recommends tmux curl procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts
COPY server/package.json server/package-lock.json ./server/
RUN cd server && bun install --frozen-lockfile --ignore-scripts
COPY agent-node ./agent-node
COPY agent-network ./agent-network
COPY server ./server
COPY tests/test751-codex-copresence-windows/fake-codex.mjs ./tests/test751-codex-copresence-windows/fake-codex.mjs
COPY tests/test-codex-copresence-first-start ./tests/test-codex-copresence-first-start
RUN chmod 0755 ./tests/test-codex-copresence-first-start/run.sh

ARG SOURCE_COMMIT
ENV T535_SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["./tests/test-codex-copresence-first-start/run.sh"]
