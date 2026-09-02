FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates jq unzip && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
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
