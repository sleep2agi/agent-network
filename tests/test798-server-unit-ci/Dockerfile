ARG SOURCE_COMMIT
FROM node:22-bookworm-slim
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl git python3 unzip util-linux \
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
COPY server/package.json server/package-lock.json ./server/
# 🔴 npm ci 而不是 npm install:ci 严格按 lockfile 装,install 会按 caret 解析
# 「当下最新的兼容版本」。后者意味着同一个 commit 在不同时间构建出不同依赖图 ——
# 上游发一个兼容版本就能让这道门变红或改变被测行为,而仓库一个字节都没动。
RUN cd server && npm ci

COPY server ./server
# RFC-026 G9 / RFC-028 P1 的漂移门比对 hub 与 daemon 的同名共享源码,
# 要读同级 agent-node/src/shared。只带这个目录,不带整个包。
# 若干 server 测试跨包 import agent-node 的源码(hub↔daemon 漂移门比对
# shared/*.ts;peer-reply-atomic 用 reply-reliability;dashboard-slash-routing
# 用 inbox-dispatch)。带整个 src,不带它的依赖 —— 这些是纯源码 import。
COPY agent-node/package.json ./agent-node/package.json
COPY agent-node/src ./agent-node/src
# scheduled-tasks-http.test.ts 起两个真 Hub 进程抢同一个 occurrence,
# worker 脚本在 tests/test601-hub-scheduled-tasks 下,按仓根相对路径 import。
COPY tests/test601-hub-scheduled-tasks ./tests/test601-hub-scheduled-tasks
COPY tests/test798-server-unit-ci/run.sh ./tests/test798-server-unit-ci/run.sh

ARG SOURCE_COMMIT
ARG RUNSH_BLOB
ENV TEST798_SOURCE_COMMIT=$SOURCE_COMMIT
# run.sh 在 SOURCE_COMMIT 下的 git blob 哈希 —— 让容器内能验证「报告里的 SHA
# 确实对应镜像里被测的字节」,而不是只验 SHA 的格式。
ENV TEST798_RUNSH_BLOB=$RUNSH_BLOB

RUN chmod 0755 ./tests/test798-server-unit-ci/run.sh \
  && install -d -o node -g node -m 0700 "/run/user/$(id -u node)" \
  && chown -R node:node /workspace

ENTRYPOINT ["bash", "tests/test798-server-unit-ci/run.sh"]
