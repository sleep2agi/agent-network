FROM node:22-bookworm-slim

# scripts/qa.sh 靠 grep `^ARG SOURCE_COMMIT` 决定传不传 --build-arg。
# 没有这一行就**不传,而且不报错** —— 这次运行的输出无法被钉到任何提交上。
ARG SOURCE_COMMIT=dev
ENV SOURCE_COMMIT=$SOURCE_COMMIT

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl git python3 unzip util-linux \
  && rm -rf /var/lib/apt/lists/*

# 钉版本 + sha256,照 tests/test679-task-trace/Dockerfile 的样板。
# `curl https://bun.sh/install | bash` 取的是「当时最新」的 bun ——
# 同一个 Dockerfile 今天和下周构建出不同的运行时,红了无从复现。
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
RUN curl --fail --silent --show-error --location --retry 3 --retry-delay 2 --retry-all-errors \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
 && echo "${BUN_LINUX_X64_SHA256}  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/bun.zip -d /tmp/bunx \
 && mkdir -p /root/.bun/bin \
 && mv /tmp/bunx/bun-linux-x64/bun /root/.bun/bin/bun \
 && chmod 0755 /root/.bun/bin/bun \
 && rm -rf /tmp/bun.zip /tmp/bunx
ENV PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"

WORKDIR /workspace
# 🔴 bun.lock 带星。agent-node/.gitignore 第 3 行忽略了 bun.lock ——
# 作者本地有这个文件,干净检出没有。不带星时 COPY 直接失败:
#   failed to compute cache key: "/agent-node/bun.lock": not found
# 于是「本地构建通过、CI 构建失败」。
# 仓里 test34 / test467 / test697 / test698 都是 `bun.lock*`,这里是唯一漏的。
COPY agent-node/package.json agent-node/bun.lock* ./agent-node/

RUN cd agent-node && bun install

COPY . /workspace

ENTRYPOINT ["bash", "tests/test626-grok-model-switch-fallback/run.sh"]
