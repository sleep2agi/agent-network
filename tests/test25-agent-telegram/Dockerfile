FROM oven/bun:1
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false

WORKDIR /app

RUN apt-get update && apt-get install -y curl python3 openssl make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY server/ server/
COPY agent-network/ agent-network/
COPY agent-node/ agent-node/

RUN cd server && bun install
RUN cd agent-network && npm install --ignore-scripts 2>/dev/null || true
RUN cd agent-node && npm install --ignore-scripts 2>/dev/null || true

COPY tests/test25-agent-telegram/run.sh /app/run.sh
RUN chmod +x /app/run.sh

ENV COMMHUB_AUTH_TOKEN=test-auth-token

CMD ["bash", "/app/run.sh"]
