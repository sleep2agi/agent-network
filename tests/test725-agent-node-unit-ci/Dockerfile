ARG SOURCE_COMMIT
FROM node:22-bookworm-slim
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates cron curl python3 unzip util-linux \
  && rm -rf /var/lib/apt/lists/*

RUN curl --fail --silent --show-error --location \
      --retry 3 --retry-delay 2 --retry-all-errors \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
      --output /tmp/bun-linux-x64.zip \
  && echo "${BUN_LINUX_X64_SHA256}  /tmp/bun-linux-x64.zip" | sha256sum --check --strict \
  && unzip -j /tmp/bun-linux-x64.zip 'bun-linux-x64/bun' -d /usr/local/bin \
  && chmod 0755 /usr/local/bin/bun \
  && test "$(bun --version)" = "$BUN_VERSION" \
  && rm -f /tmp/bun-linux-x64.zip

WORKDIR /workspace
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
# 🔴 两边都用 npm ci。原来 agent-node 走的是 npm install —— 而它旁边的
# agent-network 在同一条 RUN 里已经在用 ci 了,只是 agent-node 没有 lockfile。
# install 会按 caret 解析"当下最新的兼容版本",意味着同一个 commit 在不同
# 时间构建出不同依赖图:上游发一个兼容版本就能让这道门变红或改变被测行为,
# 而仓库一个字节都没动。
RUN cd agent-node && npm ci --include=optional \
  && cd ../agent-network && npm ci

ARG SOURCE_COMMIT
ENV TEST725_SOURCE_COMMIT=$SOURCE_COMMIT

COPY agent-node ./agent-node
COPY agent-network ./agent-network
COPY tests/test725-agent-node-unit-ci/run.sh ./tests/test725-agent-node-unit-ci/run.sh
RUN chmod 0755 ./tests/test725-agent-node-unit-ci/run.sh \
  && install -d -o node -g node -m 0700 "/run/user/$(id -u node)" \
  && chown -R node:node /workspace

ENTRYPOINT ["bash", "tests/test725-agent-node-unit-ci/run.sh"]
