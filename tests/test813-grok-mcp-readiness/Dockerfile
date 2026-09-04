FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false

ARG SOURCE_COMMIT
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl python3 unzip util-linux \
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
RUN install -d -o node -g node -m 0700 "/run/user/$(id -u node)" \
  && chown node:node /workspace
USER node
COPY --chown=node:node agent-node/package.json ./agent-node/
COPY --chown=node:node agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-node && npm install --include=optional \
  && cd ../agent-network && npm ci

ENV TEST813_SOURCE_COMMIT=$SOURCE_COMMIT

COPY --chown=node:node agent-network/src ./agent-network/src
COPY --chown=node:node agent-node/src ./agent-node/src
COPY --chown=node:node tests/test813-grok-mcp-readiness ./tests/test813-grok-mcp-readiness
COPY --chown=node:node tests/test225-grok-preview-package-live/fake-grok.mjs ./tests/test813-grok-mcp-readiness/fake-grok.mjs
COPY --chown=node:node tests/lib/safe-rm.sh ./tests/lib/safe-rm.sh

RUN chmod 0755 tests/test813-grok-mcp-readiness/run.sh \
  tests/test813-grok-mcp-readiness/product-path.sh \
  tests/test813-grok-mcp-readiness/fake-grok.mjs

ENTRYPOINT ["bash", "tests/test813-grok-mcp-readiness/run.sh"]
