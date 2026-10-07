ARG SOURCE_COMMIT
FROM oven/bun:1.3.14
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY agent-node/src ./agent-node/src
COPY tests/test703-codex-turn-receipts ./tests/test703-codex-turn-receipts
ARG SOURCE_COMMIT=local
ENV SOURCE_COMMIT=$SOURCE_COMMIT TEST703_CONTAINER=1
RUN chmod 0755 tests/test703-codex-turn-receipts/run.sh
ENTRYPOINT ["tests/test703-codex-turn-receipts/run.sh"]
