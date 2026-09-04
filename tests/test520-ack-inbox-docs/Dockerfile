FROM node:22-bookworm-slim
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false

WORKDIR /workspace
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
COPY docs-site/package*.json docs-site/
RUN npm ci --prefix docs-site --ignore-scripts
COPY server/src/tools.ts server/src/tools.ts
COPY docs-site docs-site
COPY tests/test520-ack-inbox-docs/run.sh tests/test520-ack-inbox-docs/run.sh
RUN chmod +x tests/test520-ack-inbox-docs/run.sh

ARG TEST520_SOURCE_COMMIT=unknown
ENV TEST520_SOURCE_COMMIT=$TEST520_SOURCE_COMMIT

CMD ["tests/test520-ack-inbox-docs/run.sh"]
