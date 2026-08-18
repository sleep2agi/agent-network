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
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && npm ci

COPY agent-node/package.json ./agent-node/package.json
# tests/feishu-envelope-compat.test.ts 跨包 import agent-node 的 runtime 源码。
COPY agent-node/src ./agent-node/src
COPY agent-network ./agent-network
COPY tests/test745-agent-network-unit-ci/run.sh ./tests/test745-agent-network-unit-ci/run.sh

ARG SOURCE_COMMIT
ENV TEST745_SOURCE_COMMIT=$SOURCE_COMMIT

# tests/feishu-bridge-ipc.test.ts 把附件落在硬编码的 /work/feishu-attachments 下,
# 不是 workspace 相对路径。给 node 建出来,否则它红在 EACCES 上、看着像产品坏。
RUN install -d -o node -g node -m 0755 /work \
 && chmod 0755 ./tests/test745-agent-network-unit-ci/run.sh \
  && install -d -o node -g node -m 0700 "/run/user/$(id -u node)" \
  && chown -R node:node /workspace

ENTRYPOINT ["bash", "tests/test745-agent-network-unit-ci/run.sh"]
