FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git diffutils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY scripts/sync-pinned-versions.sh scripts/sync-pinned-versions.sh
COPY agent-network/src/opencode-agent-node-pair.ts agent-network/src/opencode-agent-node-pair.ts
COPY docs-site/docs/guide/runtimes.md docs-site/docs/guide/runtimes.md
COPY docs-site/docs/en/guide/runtimes.md docs-site/docs/en/guide/runtimes.md
# 🔴 这份 COPY 清单编码了 sync 脚本注册表的范围。
# 注册表里多一个文件,这里就必须多一行 —— 否则脚本在容器里报
# MISSING TARGET,dry-run 非零退出,而红的理由和被测行为无关。
# (2026-08-27 就是这样红的:注册了三包的 package.json/lock,镜像里没有。)
COPY agent-node/package.json agent-node/package.json
COPY agent-node/package-lock.json agent-node/package-lock.json
COPY agent-network/package.json agent-network/package.json
COPY agent-network/package-lock.json agent-network/package-lock.json
COPY server/package.json server/package.json
COPY server/package-lock.json server/package-lock.json
COPY tests/test1183-sync-pinned-dryrun/run.sh tests/test1183-sync-pinned-dryrun/run.sh

RUN git init -q && git config user.email test@example.invalid && git config user.name test \
 && git add . && git commit -qm baseline

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT
CMD ["bash", "tests/test1183-sync-pinned-dryrun/run.sh"]
