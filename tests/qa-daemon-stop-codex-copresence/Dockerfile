# #596 —— daemon 建的 Codex TUI 共存节点,daemon 的 stop_node / delete_node 能不能真把它停掉。
# 真 hub + 真 `anet daemon up` + 真 create_node(flags.copresence)+ 真 tmux + 真 codex(钉版本,
# 与 test466 同一个)。安装形状照 qa-create-node-codex-copresence:本地源码 npm pack 后全局装。
# tmux 只在这个容器里跑(容器自己的默认 tmux 服务器),不碰宿主任何 tmux。
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

# 真 vendor 二进制,与 test466 同版本。app-server / TUI 协议全由它跑。
RUN npm install -g --no-audit --no-fund @openai/codex@0.147.0

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

# 🔴 bun/bunx 也放进 /usr/local/bin:daemon 用 minimalEnv() 起子进程,PATH 只有 node 所在目录 + SAFE_PATH,
#    不含 ~/.bun/bin;共存启动器的依赖预检要 bunx,缺了它会在 5 秒内退出、什么会话都不起。
RUN ln -s /root/.bun/bin/bun /usr/local/bin/bun && ln -s /root/.bun/bin/bun /usr/local/bin/bunx

# 复用 #2415 的本地 @sleep2agi 注册表(发版 PR 上配对版本还没上 npm)。
COPY tests/qa-create-node-codex-copresence/paired-registry.py /app/tests/qa-create-node-codex-copresence/paired-registry.py
COPY tests/qa-daemon-stop-codex-copresence/run.sh /app/tests/qa-daemon-stop-codex-copresence/run.sh
RUN chmod +x /app/tests/qa-daemon-stop-codex-copresence/run.sh

# daemon minimalEnv strips the parent export; isolate its child launches too.
# This interpreter wrapper exists only in this non-admission test image.
COPY tests/lib/node-no-start-gate.sh /tmp/node-no-start-gate.sh
RUN install -m 0755 /tmp/node-no-start-gate.sh /usr/local/sbin/node \
 && env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/bin:/bin HOME=/tmp node -e 'if (process.env.ANET_START_MEM_GATE !== "0") process.exit(1)'

ARG SOURCE_COMMIT=unknown
ENV DSCC_SOURCE_COMMIT=$SOURCE_COMMIT

CMD ["/app/tests/qa-daemon-stop-codex-copresence/run.sh"]
