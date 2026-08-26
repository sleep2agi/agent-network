FROM oven/bun:1.2.22-debian

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl fonts-dejavu-core imagemagick jq nodejs npm util-linux \
    && npm install -g --no-audit --no-fund @openai/codex@0.148.0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY agent-node/package.json agent-node/package.json
COPY server/package.json server/package.json
RUN cd agent-node && bun install --ignore-scripts \
    && cd ../server && bun install --ignore-scripts
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
COPY agent-node/src agent-node/src
COPY server/src server/src
COPY tests/lib /tests/lib
COPY tests/test1190-codex-btw-wire-probe/disposable-home.sentinel /probe/disposable-home.sentinel
COPY tests/test1204-btw-production-wiring tests/test1204-btw-production-wiring
RUN chmod +x tests/test1204-btw-production-wiring/run.sh \
    tests/test1204-btw-production-wiring/verify-source.sh \
    tests/test1204-btw-production-wiring/production-process-e2e.sh \
    tests/test1204-btw-production-wiring/fake-codex \
    && ln -s fake-codex tests/test1204-btw-production-wiring/codex
CMD ["tests/test1204-btw-production-wiring/run.sh"]
