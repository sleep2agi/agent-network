# #584 app「Codex（TUI 共存）」经 daemon 建节点 —— 真 hub + 真 `anet daemon up` + 真 create_node。
# 安装形状照 qa-create-node-workdir:本地源码 npm pack 后全局装,PATH 上的 anet 就是被测代码。
# 镜像里故意**没有** tmux 和 codex:共存路径会在依赖预检处报缺,这句话本身就是「走了共存」的证据。
FROM node:22-bookworm-slim
ENV npm_config_audit=false npm_config_fund=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq unzip procps \
    build-essential python3 sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# bun 钉版本 + sha256(check-bun-install-pin;照 tests/test679-task-trace/Dockerfile)
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

WORKDIR /app

COPY server /app/server
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network

RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent && bun run build
RUN cd /app/agent-network && bun install --silent && bun run build

RUN cd /app/agent-node && npm pack && npm install -g ./sleep2agi-agent-node-*.tgz
RUN cd /app/agent-network && npm pack && npm install -g ./sleep2agi-agent-network-*.tgz

RUN anet --version && which anet && which agent-node

# 套件脚本放最后:改 run.sh 只重建这几层。
COPY tests/qa-create-node-codex-copresence/run.sh /app/tests/qa-create-node-codex-copresence/run.sh
COPY tests/qa-create-node-codex-copresence/paired-registry.py /app/tests/qa-create-node-codex-copresence/paired-registry.py
RUN chmod +x /app/tests/qa-create-node-codex-copresence/run.sh

# 镜像 ↔ 提交绑定(run.sh 校验 run.sh 自身的 blob)。
# daemon minimalEnv strips the parent export; isolate its child launches too.
# This interpreter wrapper exists only in this non-admission test image.
COPY tests/lib/node-no-start-gate.sh /tmp/node-no-start-gate.sh
RUN mv /usr/local/bin/node /usr/local/bin/node-with-start-gate \
 && install -m 0755 /tmp/node-no-start-gate.sh /usr/local/bin/node \
 && env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp node -e 'if (process.env.ANET_START_MEM_GATE !== "0") process.exit(1)'

ARG SOURCE_COMMIT
ARG RUNSH_BLOB
ENV CNCC_SOURCE_COMMIT=$SOURCE_COMMIT
ENV CNCC_RUNSH_BLOB=$RUNSH_BLOB

CMD ["/app/tests/qa-create-node-codex-copresence/run.sh"]
