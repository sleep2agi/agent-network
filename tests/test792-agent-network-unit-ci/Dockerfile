ARG SOURCE_COMMIT
FROM node:22-bookworm-slim
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates cron curl git python3 unzip util-linux \
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

ARG SOURCE_COMMIT
ENV TEST792_SOURCE_COMMIT=$SOURCE_COMMIT

COPY agent-network ./agent-network
# opencode-agent-node-pair.test.ts 校验 agent-network↔agent-node 的配对 pin,
# 要读同级 agent-node 的 package.json。只带这一个文件,不带整个包。
COPY agent-node/package.json ./agent-node/package.json
COPY tests/test792-agent-network-unit-ci/run.sh ./tests/test792-agent-network-unit-ci/run.sh
RUN chmod 0755 ./tests/test792-agent-network-unit-ci/run.sh \
  && install -d -o node -g node -m 0700 "/run/user/$(id -u node)" \
  && chown -R node:node /workspace

ENTRYPOINT ["bash", "tests/test792-agent-network-unit-ci/run.sh"]
