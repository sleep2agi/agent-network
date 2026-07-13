ARG SOURCE_COMMIT
FROM oven/bun:1.3.1
ARG SOURCE_COMMIT
ENV TEST224_SOURCE_COMMIT=$SOURCE_COMMIT

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates nodejs npm tar util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Dependency resolution is deliberately confined to image construction.  The
# actual gate is run with --network none and uses only the resulting image.
COPY agent-node/package.json ./agent-node/package.json
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-node && bun install --ignore-scripts \
  && cd ../agent-network && bun install --ignore-scripts

# Copy only package inputs and this suite.  In particular, never copy .git,
# host config, auth files, existing reports, or a developer's node_modules.
COPY agent-node/src ./agent-node/src
COPY agent-node/README.md agent-node/LICENSE agent-node/NOTICE ./agent-node/
COPY agent-network/bin ./agent-network/bin
COPY agent-network/src ./agent-network/src
COPY agent-network/tsconfig.json agent-network/README.md agent-network/LICENSE agent-network/NOTICE ./agent-network/
COPY tests/test224-grok-preview-security ./tests/test224-grok-preview-security

ENTRYPOINT ["bash", "tests/test224-grok-preview-security/run.sh"]
