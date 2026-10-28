FROM oven/bun:1
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false

WORKDIR /app

RUN apt-get update && apt-get install -y curl python3 make g++ && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# #2846 —— 依赖安装层必须只依赖 lockfile,否则任何源码改动都会击穿它。
# 🔴 只 COPY **git 里有的** 文件:server/bun.lock 在 .gitignore 里(本地有、CI checkout 里没有),
#    把它写进 COPY 会让 CI 在 1 秒内 build fail —— 本地因为文件在磁盘上所以看不出来。
#    原来那段 `COPY server/ server/` 在 CI 里同样拿不到 bun.lock,所以这里去掉它不改变任何行为。
COPY server/package.json server/package-lock.json server/
RUN cd server && bun install
COPY agent-network/package.json agent-network/package-lock.json agent-network/
RUN cd agent-network && npm install --ignore-scripts 2>/dev/null || true
COPY agent-node/package.json agent-node/package-lock.json agent-node/
RUN cd agent-node && npm install --ignore-scripts 2>/dev/null || true

COPY server/ server/
COPY agent-network/ agent-network/
COPY agent-node/ agent-node/
RUN cd agent-network && npm run build && npm install -g .
RUN cd agent-node && npm run build && npm link
RUN cd agent-node && npm install @openai/codex-sdk 2>/dev/null || true
RUN mkdir -p /root/.anet && echo '{"hub":"http://127.0.0.1:9200","token":"test-auth-token"}' > /root/.anet/config.json

COPY tests/test8-runtime/run.sh /app/run.sh
RUN chmod +x /app/run.sh

ENV COMMHUB_AUTH_TOKEN=test-auth-token

ARG TEST8_SOURCE_COMMIT=dev
ENV TEST8_SOURCE_COMMIT=$TEST8_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST8_SOURCE_COMMIT

CMD ["bash", "/app/run.sh"]
