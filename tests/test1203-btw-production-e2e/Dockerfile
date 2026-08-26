FROM oven/bun:1.2.22-debian

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates jq nodejs npm \
    && npm install -g --no-audit --no-fund @openai/codex@0.148.0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY agent-node/package.json agent-node/package.json
COPY agent-node/src agent-node/src
COPY tests/lib tests/lib
COPY tests/lib /tests/lib
COPY tests/test1190-codex-btw-wire-probe /probe
COPY tests/test1203-btw-production-e2e tests/test1203-btw-production-e2e
RUN chmod +x /probe/run.sh tests/test1203-btw-production-e2e/run.sh

CMD ["tests/test1203-btw-production-e2e/run.sh"]
