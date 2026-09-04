FROM node:20-bookworm
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    tmux \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install anet from npm (preview tag — once 2.1.9+ ships with pr-review demo,
# adjust to `@sleep2agi/agent-network@preview` or pin). For local CI runs
# against the in-repo build, mount the worktree and run `npm pack` + install
# the tarball.
RUN npm install -g @sleep2agi/agent-network@preview || true

COPY tests/test28-pr-review-room/samples /app/samples
COPY tests/test28-pr-review-room/expected /app/expected
COPY tests/test28-pr-review-room/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["bash", "/app/run.sh"]
