ARG SOURCE_COMMIT
FROM node:22-bookworm-slim
# 与 test750 同理:npm 只装依赖,audit/fund 端点挂起会把构建拖到超时守卫。
ENV npm_config_audit=false npm_config_fund=false
ARG SOURCE_COMMIT
ENV TEST_EXTAPP_SOURCE_COMMIT=$SOURCE_COMMIT
# Pinned bun, per the ratchet in .github/scripts/check-bun-install-pin.py.
# Version + checksum copied from tests/test750-codex-copresence-onecommand/Dockerfile.
# ENV, not ARG: the suite runner passes --build-arg NAME=$GITHUB_SHA for every ARG.
ENV BUN_VERSION=1.3.14
ENV BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl python3 tmux unzip procps \
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
# --ignore-scripts: no PTY is opened by anet here; node-pty's native build is dead weight.
RUN cd agent-network && npm ci --ignore-scripts

# Fake `codex`: serves /readyz for `app-server --listen`, idles for `resume`,
# and records argv + env NAMES (never values) per process.
COPY tests/test-codex-external-appserver/fake-codex.cjs /usr/local/bin/codex
RUN chmod 0755 /usr/local/bin/codex

COPY . /workspace
RUN rm -rf /workspace/.git /workspace/.anet

ENTRYPOINT ["bash", "tests/test-codex-external-appserver/run.sh"]
