FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates unzip python3 && rm -rf /var/lib/apt/lists/*
# 🔴 钉死 Bun 输入。原来是 `curl -fsSL https://bun.sh/install | bash` ——
# 构建时装到什么算什么,同一个 commit 在不同时间会跑在不同字节上。
# 版本与校验和沿用本仓既有做法(见 tests/test745-agent-network-unit-ci/Dockerfile)。
# 隔离验证过:改前改后都得到 bun 1.3.14、同在 /root/.bun/bin/bun,产出等价。
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
ENV PATH="/root/.bun/bin:${PATH}"
WORKDIR /app
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network
COPY server /app/server
RUN cd /app/agent-node && bun install --silent
RUN cd /app/agent-network && bun install --silent --ignore-scripts
RUN cd /app/server && bun install --silent
ARG TEST679_SOURCE_COMMIT=unknown
ENV TEST679_SOURCE_COMMIT=${TEST679_SOURCE_COMMIT}
COPY tests/test679-task-trace /app/tests/test679-task-trace
CMD ["/app/tests/test679-task-trace/run.sh"]
