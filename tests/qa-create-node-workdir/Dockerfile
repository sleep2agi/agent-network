# app「新建节点」工作目录 e2e —— 真 hub + 真 `anet daemon up` + 真 create_node / stop / start / delete。
# 安装形状照 qa-daemon-lifecycle-e2e:本地源码 npm pack 后全局装,PATH 上的 anet 就是被测代码。
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

# 场景 F 原样读开机 sweep 的取集那一行,判断默认根的理由今天还成立。
COPY deploy/fleet/anet-nodes-boot.sh /app/deploy/fleet/anet-nodes-boot.sh
# 套件脚本放最后:改 run.sh 只重建这几层。
COPY tests/qa-create-node-workdir/run.sh /app/tests/qa-create-node-workdir/run.sh
RUN chmod +x /app/tests/qa-create-node-workdir/run.sh

# 镜像 ↔ 提交绑定(run.sh 校验 run.sh 自身的 blob)。
ARG SOURCE_COMMIT
ARG RUNSH_BLOB
ENV CNWD_SOURCE_COMMIT=$SOURCE_COMMIT
ENV CNWD_RUNSH_BLOB=$RUNSH_BLOB

CMD ["/app/tests/qa-create-node-workdir/run.sh"]
