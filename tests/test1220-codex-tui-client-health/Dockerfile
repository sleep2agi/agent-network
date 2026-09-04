ARG SOURCE_COMMIT
FROM node:22-bookworm-slim
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false

ENV BUN_VERSION=1.3.14
ENV BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl procps tmux unzip \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --silent --show-error --location --retry 5 --retry-delay 5 --retry-all-errors \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
      --output /tmp/bun.zip \
 && echo "${BUN_LINUX_X64_SHA256}  /tmp/bun.zip" | sha256sum --check --strict \
 && unzip -j /tmp/bun.zip 'bun-linux-x64/bun' -d /usr/local/bin \
 && chmod 0755 /usr/local/bin/bun \
 && test "$(bun --version)" = "$BUN_VERSION" \
 && rm /tmp/bun.zip
WORKDIR /workspace
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
COPY server/package.json server/package-lock.json ./server/
RUN cd agent-node && npm ci --ignore-scripts \
 && cd ../agent-network && npm ci --ignore-scripts \
 && cd ../server && npm ci --ignore-scripts
COPY agent-node ./agent-node
COPY agent-network ./agent-network
COPY server ./server
COPY tests/test751-codex-copresence-windows ./tests/test751-codex-copresence-windows
COPY tests/test1191-windows-steer-contract/linux-e2e.mjs /linux-e2e.mjs
COPY tests/test1220-codex-tui-client-health/run.sh /run.sh
COPY tests/test584-dashboard-codex-delivery/mutate.ts /mutate.ts
RUN chmod 0755 /run.sh
ARG SOURCE_COMMIT
ENV TEST1220_SOURCE_COMMIT=$SOURCE_COMMIT
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENTRYPOINT ["/run.sh"]
