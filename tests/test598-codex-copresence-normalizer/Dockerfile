FROM oven/bun:1.3.14
RUN apt-get update && apt-get install -y --no-install-recommends bash tmux iproute2 procps ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY agent-network/scripts/codex-copresence-fleet-config.mjs /workspace/scripts/
COPY agent-network/scripts/normalize-codex-copresence-node.sh /workspace/scripts/
COPY tests/lib/safe-rm.sh /workspace/tests/lib/safe-rm.sh
COPY tests/test598-codex-copresence-normalizer /workspace/tests/test598-codex-copresence-normalizer
ARG SOURCE_COMMIT
ENV TEST598_SOURCE_COMMIT=$SOURCE_COMMIT
RUN chmod 0755 /workspace/scripts/* /workspace/tests/test598-codex-copresence-normalizer/run.sh
ENTRYPOINT ["/workspace/tests/test598-codex-copresence-normalizer/run.sh"]
