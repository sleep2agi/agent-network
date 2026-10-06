FROM oven/bun:1.3.9
RUN apt-get update && apt-get install -y --no-install-recommends tmux && rm -rf /var/lib/apt/lists/*
WORKDIR /test
COPY --chown=bun:bun agent-node/src ./agent-node/src
COPY --chown=bun:bun tests/test658-codex-adopt-stop ./tests/test658-codex-adopt-stop
ARG SOURCE_COMMIT=local
ENV SOURCE_COMMIT=$SOURCE_COMMIT
USER bun
CMD ["sh", "tests/test658-codex-adopt-stop/run.sh"]
