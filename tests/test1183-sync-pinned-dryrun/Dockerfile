FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git diffutils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY scripts/sync-pinned-versions.sh scripts/sync-pinned-versions.sh
COPY agent-network/src/opencode-agent-node-pair.ts agent-network/src/opencode-agent-node-pair.ts
COPY docs-site/docs/guide/runtimes.md docs-site/docs/guide/runtimes.md
COPY docs-site/docs/en/guide/runtimes.md docs-site/docs/en/guide/runtimes.md
COPY tests/test1183-sync-pinned-dryrun/run.sh tests/test1183-sync-pinned-dryrun/run.sh

RUN git init -q && git config user.email test@example.invalid && git config user.name test \
 && git add . && git commit -qm baseline

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT
CMD ["bash", "tests/test1183-sync-pinned-dryrun/run.sh"]
