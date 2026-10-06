FROM oven/bun:1.3.9
RUN apt-get update && apt-get install -y --no-install-recommends tmux && rm -rf /var/lib/apt/lists/*
WORKDIR /test
COPY agent-node/src ./agent-node/src
COPY tests/test658-codex-adopt-stop ./tests/test658-codex-adopt-stop
USER bun
CMD ["bun", "test", "./agent-node/src/runtime/adopt-codex-evidence.test.ts", "./tests/test658-codex-adopt-stop/collect.test.ts"]
