FROM oven/bun:1.3.14
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl python3 make g++ nodejs npm \
 && rm -rf /var/lib/apt/lists/*

COPY agent-network/ /app/agent-network/
RUN cd /app/agent-network && npm install && npm run build && npm install -g .

COPY server/ /app/server/
RUN cd /app/server && bun install

COPY agent-node/ /app/agent-node/
RUN cd /app/agent-node && npm install && npm run build && npm link

COPY tests/docker-e2e-networks.sh /app/test-networks.sh
COPY tests/docker-config-priority.sh /app/test-config.sh
COPY tests/test313-test-all-v3-fixtures/run.sh /app/run.sh
RUN chmod +x /app/test-networks.sh /app/test-config.sh /app/run.sh

ARG TEST313_SOURCE_COMMIT=unknown
ENV TEST313_SOURCE_COMMIT=$TEST313_SOURCE_COMMIT

CMD ["/app/run.sh"]
