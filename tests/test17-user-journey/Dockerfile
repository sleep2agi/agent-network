FROM oven/bun:1
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false
WORKDIR /app
RUN apt-get update && apt-get install -y curl python3 nodejs npm && rm -rf /var/lib/apt/lists/*
# @preview is a MOVING tag: right after a publish its tarball can 404 for ~25–95 s and npm does not
# retry (#564). The shared helper resolves → waits for the tarball (≤10 min) → installs the exact
# version, and on failure prints FAIL + the npm log tail into the build log.
COPY tests/lib/install-published.sh /lib/install-published.sh
RUN bash -c 'set -euo pipefail; . /lib/install-published.sh; \
      for p in commhub-server agent-network agent-node; do \
        install_published "@sleep2agi/$p" preview /tmp/npm-install.log; \
      done'
COPY tests/test17-user-journey/run.sh /app/run.sh
RUN chmod +x /app/run.sh
ARG TEST17_SOURCE_COMMIT=dev
ENV TEST17_SOURCE_COMMIT=$TEST17_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST17_SOURCE_COMMIT

CMD ["bash", "/app/run.sh"]
