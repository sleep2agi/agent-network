# Daemon full-chain lifecycle e2e — `anet daemon up` → create_node →
# update_node_config → restart_node → stop_node, on ONE child within ONE
# daemon lifetime. Fills the square qa-rfc024-config-apply explicitly
# left open ("that belongs in the longer-form QA" — it takes the `skip`
# branch because no live agent-node is running).
#
# Install pattern mirrors qa-anet-daemon-cmd: glibc base + bun +
# build-essential + python3, LOCAL source installed globally via npm pack
# so `anet` on PATH is the code under test, not a registry build.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq unzip procps \
    build-essential python3 sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# 🔴 钉死 Bun 输入。原来这里照抄了 qa-anet-daemon-cmd 的
# `curl -fsSL https://bun.sh/install | bash` —— 那是 check-bun-install-pin
# 基线里的存量写法,照抄等于把它的债一起搬进一个新文件,而那道棘轮门只对
# **新增**变红。构建时装到什么算什么,同一个 commit 在不同时间会跑在不同字节上。
# 版本与校验和沿用本仓既有做法(tests/test679-task-trace/Dockerfile)。
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

# Fail the BUILD (not the run) if the binaries under test are missing.
RUN anet --version && which anet && which agent-node

# The test scripts go LAST on purpose: editing run.sh then rebuilds only
# these layers (seconds) instead of invalidating three bun installs.
COPY tests/lib /app/tests/lib
COPY tests/qa-daemon-lifecycle-e2e/run.sh /app/tests/qa-daemon-lifecycle-e2e/run.sh
RUN chmod +x /app/tests/qa-daemon-lifecycle-e2e/run.sh

# Provenance. scripts/qa.sh reads these ARG names out of this file (it does
# not derive them from the suite name), so they must be spelled exactly
# `SOURCE_COMMIT` / `RUNSH_BLOB`. Without them the suite would run with no
# binding between the image and the commit its report claims — and that
# failure is silent: the output looks completely normal.
ARG SOURCE_COMMIT
ARG RUNSH_BLOB
ENV DLIFE_SOURCE_COMMIT=$SOURCE_COMMIT
ENV DLIFE_RUNSH_BLOB=$RUNSH_BLOB

CMD ["/app/tests/qa-daemon-lifecycle-e2e/run.sh"]
