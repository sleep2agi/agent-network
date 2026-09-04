ARG SOURCE_COMMIT
FROM oven/bun:1
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates nodejs npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server /app/server
COPY prototype/anet-client-app /app/prototype/anet-client-app
COPY tests/test1280-desktop-user-push/run.sh /app/tests/test1280-desktop-user-push/run.sh

RUN chmod +x /app/tests/test1280-desktop-user-push/run.sh
RUN cd /app/server && npm ci
RUN cd /app/prototype/anet-client-app && npm ci

ARG SOURCE_COMMIT
ENV TEST1280_SOURCE_COMMIT=$SOURCE_COMMIT

CMD ["/app/tests/test1280-desktop-user-push/run.sh"]
