FROM node:22-bookworm
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false

WORKDIR /workspace/docs-site
COPY docs-site/package.json docs-site/package-lock.json ./
RUN npm ci

WORKDIR /workspace
COPY README.md README.en.md ./
COPY docs-site ./docs-site
COPY docs ./docs
COPY tests/qa-frontdoor-docs/run.mjs ./tests/qa-frontdoor-docs/run.mjs

ARG SOURCE_COMMIT=dev
ENV SOURCE_COMMIT=$SOURCE_COMMIT

CMD ["node", "tests/qa-frontdoor-docs/run.mjs"]
