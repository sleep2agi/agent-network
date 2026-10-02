FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates jq unzip && rm -rf /var/lib/apt/lists/*
# bun 钉版本 + sha256(check-bun-install-pin 门)。用 ENV 不用 ARG:qa.yml 的 matrix 步骤把 Dockerfile 里
# 每个 `ARG` 名都当成 --build-arg NAME=$GITHUB_SHA 传进来(不看有没有默认值),ARG 会被顶成提交号 → 下载 404。
# 同 tests/test1220-codex-tui-client-health/Dockerfile。
ENV BUN_VERSION=1.3.14
ENV BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
RUN curl --fail --silent --show-error --location --retry 5 --retry-delay 5 --retry-all-errors \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
 && echo "${BUN_LINUX_X64_SHA256}  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/bun.zip -d /tmp/bunx \
 && mkdir -p /root/.bun/bin \
 && mv /tmp/bunx/bun-linux-x64/bun /root/.bun/bin/bun \
 && chmod 0755 /root/.bun/bin/bun \
 && rm -rf /tmp/bun.zip /tmp/bunx
ENV PATH="/root/.bun/bin:${PATH}"

# 证明镜像里跑的是哪个提交(run.sh 拒绝 unknown)。
ARG SOURCE_COMMIT=unknown
ENV QA_HUB_21_SOURCE_COMMIT=${SOURCE_COMMIT}

COPY server /app/server
RUN cd /app/server && bun install --silent
# 套件脚本放在 bun install 之后:改一行 run.sh 不用重装依赖。
COPY tests/lib /app/tests/lib
COPY tests/qa-hub-21-schedule-stuck /app/tests/qa-hub-21-schedule-stuck
RUN chmod +x /app/tests/qa-hub-21-schedule-stuck/run.sh

CMD ["/app/tests/qa-hub-21-schedule-stuck/run.sh"]
