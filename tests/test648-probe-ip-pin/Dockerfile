FROM oven/bun:1.3.14 AS bun-runtime
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false

FROM node:20-bookworm-slim
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && npm install --omit=optional --ignore-scripts
COPY agent-node ./agent-node
COPY tests/test648-probe-ip-pin ./tests/test648-probe-ip-pin

ARG TEST648_SOURCE_COMMIT=unknown
ENV TEST648_SOURCE_COMMIT=$TEST648_SOURCE_COMMIT
RUN chmod 0755 tests/test648-probe-ip-pin/run.sh
ENTRYPOINT ["/workspace/tests/test648-probe-ip-pin/run.sh"]
