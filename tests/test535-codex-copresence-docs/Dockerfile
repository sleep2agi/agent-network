FROM node:22.13.1-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY docs-site/package*.json docs-site/
RUN cd docs-site && npm ci

COPY docs-site/ docs-site/
COPY README.md README.en.md ./
COPY agent-network/README.md agent-network/README.md
COPY agent-node/README.md agent-node/README.md
COPY docs/rfcs/RFC-030-codex-tui-bridge.md docs/rfcs/RFC-030-codex-tui-bridge.md
COPY docs/sop/codex-app-server-jam-restart.md docs/sop/codex-app-server-jam-restart.md
COPY tests/test535-codex-copresence-docs/run.sh /app/run.sh

RUN chmod +x /app/run.sh

CMD ["bash", "/app/run.sh"]
