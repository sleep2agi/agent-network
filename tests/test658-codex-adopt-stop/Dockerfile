FROM oven/bun:1.3.9
RUN apt-get update && apt-get install -y --no-install-recommends tmux nodejs && rm -rf /var/lib/apt/lists/*
WORKDIR /test
COPY --chown=bun:bun agent-node/src ./agent-node/src
COPY --chown=bun:bun agent-network/src/stopped-receipt.ts ./agent-network/src/stopped-receipt.ts
COPY --chown=bun:bun agent-network/bin/cli.ts ./agent-network/bin/cli.ts
COPY --chown=bun:bun deploy/fleet/anet-nodes-boot.sh ./deploy/fleet/anet-nodes-boot.sh
COPY --chown=bun:bun tests/test658-codex-adopt-stop ./tests/test658-codex-adopt-stop
ARG SOURCE_COMMIT=local
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENV TEST658_CONTAINER=1
USER bun
CMD ["sh", "tests/test658-codex-adopt-stop/run.sh"]
