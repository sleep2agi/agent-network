FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

ARG SOURCE_COMMIT
ENV TEST813_SOURCE_COMMIT=$SOURCE_COMMIT

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && bun install --ignore-scripts

COPY agent-network/src ./agent-network/src
COPY agent-node/src ./agent-node/src
COPY tests/test813-grok-mcp-readiness ./tests/test813-grok-mcp-readiness
COPY tests/lib/safe-rm.sh ./tests/lib/safe-rm.sh

ENTRYPOINT ["bash", "tests/test813-grok-mcp-readiness/run.sh"]
