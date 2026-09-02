FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates jq unzip && rm -rf /var/lib/apt/lists/*
# bun 钉版本 + sha256(照 tests/test679-task-trace/Dockerfile 的样板;check-bun-install-pin 门)
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
RUN curl --fail --silent --show-error --location --retry 5 --retry-delay 5 --retry-all-errors \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
 && echo "${BUN_LINUX_X64_SHA256}  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/bun.zip -d /tmp/bunx \
 && mkdir -p /root/.bun/bin \
 && mv /tmp/bunx/bun-linux-x64/bun /root/.bun/bin/bun \
 && chmod 0755 /root/.bun/bin/bun \
 && rm -rf /tmp/bun.zip /tmp/bunx
ENV PATH="/root/.bun/bin:${PATH}"

# 证明镜像里跑的是哪个提交（同 test185 的形状；run.sh 拒绝 unknown）。
ARG TEST1755_SOURCE_COMMIT=unknown
ENV TEST1755_SOURCE_COMMIT=${TEST1755_SOURCE_COMMIT}

COPY server /app/server
COPY agent-node /app/agent-node
RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent
# 套件脚本放在 bun install 之后:改一行 run.sh 不用重装依赖(本地迭代 2-3 分钟 → 秒级)。
COPY tests/lib /app/tests/lib
COPY tests/test1755-rules-file-e2e /app/tests/test1755-rules-file-e2e
RUN chmod +x /app/tests/test1755-rules-file-e2e/run.sh

CMD ["/app/tests/test1755-rules-file-e2e/run.sh"]
