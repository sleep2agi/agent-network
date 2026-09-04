# Mirror 通信龙's environment: node:22-bookworm-slim + npm-install
# @sleep2agi/agent-network@preview + @sleep2agi/agent-node@preview
# (currently preview.17 per `npm view @sleep2agi/agent-node@preview version`).
#
# The probe runs BOTH the isolated hub AND the daemon inside this container,
# talking to 127.0.0.1:9310. Different from 通信龙's gateway topology, but
# functionally identical for the "what does the daemon send" question — the
# payload shape and DB writes are what we're after, not network routing.

FROM node:22-bookworm-slim
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl jq ca-certificates sqlite3 procps unzip && \
    rm -rf /var/lib/apt/lists/*

# Install bun for running the hub from source (we bind-mount main).
RUN curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun

# npm-install the same preview versions 通信龙 used, so we probe the
# ACTUAL published tarballs (not the /repo main source). This is what
# `anet daemon up` spawns in production when agent-node isn't in PATH.
RUN npm i -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview

WORKDIR /repo
COPY . .
WORKDIR /repo/server
RUN bun install

WORKDIR /repo
CMD ["bash", "tests/test380-daemon-telemetry-probe/run.sh"]
