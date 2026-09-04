ARG SOURCE_COMMIT
FROM node:22-bookworm-slim
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false
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
# channel-plugin-error-masking.test.ts 逐字节比对 channel/ 里的插件源码。
# 没有这行时容器里不存在 channel/,那两条断言红的理由是「文件读不到」,
# 而输出长得像「副本不一致」—— 修的是取集层,不是判据。(#1149 首航红因)
COPY channel ./channel
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
