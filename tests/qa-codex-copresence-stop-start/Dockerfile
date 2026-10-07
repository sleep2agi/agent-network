# #602 —— 手工 `anet node stop` → `anet node start`,Codex TUI 共存节点能不能再起来。
# 真 hub + 真 anet/agent-node(本地源码 npm pack 后全局装,照 qa-daemon-stop-codex-copresence)
# + 真 tmux(容器内私有 socket,ANET_TMUX_SOCKET)+ 真 codex(钉 0.147.0,与 test466 同版本)。
# 不起 daemon:这是 CLI 的缺陷,手工 stop/start 就能复现。
FROM node:22-bookworm-slim
ENV npm_config_audit=false npm_config_fund=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq unzip procps tmux \
    build-essential python3 sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# bun 钉版本 + sha256(check-bun-install-pin;照 tests/qa-create-node-codex-copresence/Dockerfile)
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

ARG CODEX_VERSION=0.147.0
RUN npm install -g --no-audit --no-fund @openai/codex@${CODEX_VERSION}

WORKDIR /app

COPY server /app/server
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network

RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent && bun run build
RUN cd /app/agent-network && bun install --silent && bun run build

RUN cd /app/agent-node && npm pack && npm install -g ./sleep2agi-agent-node-*.tgz
RUN cd /app/agent-network && npm pack && npm install -g ./sleep2agi-agent-network-*.tgz

RUN anet --version && which anet && which agent-node && codex --version && tmux -V
RUN ln -s /root/.bun/bin/bun /usr/local/bin/bun && ln -s /root/.bun/bin/bun /usr/local/bin/bunx

# 复用 #2415 的本地 @sleep2agi 注册表(发版 PR 上配对版本还没上 npm)。
COPY tests/qa-create-node-codex-copresence/paired-registry.py /app/tests/qa-create-node-codex-copresence/paired-registry.py
COPY tests/qa-codex-copresence-stop-start/run.sh /app/tests/qa-codex-copresence-stop-start/run.sh
RUN chmod +x /app/tests/qa-codex-copresence-stop-start/run.sh

ARG SOURCE_COMMIT=unknown
ENV CCSS_SOURCE_COMMIT=$SOURCE_COMMIT

CMD ["/app/tests/qa-codex-copresence-stop-start/run.sh"]
