ARG SOURCE_COMMIT
FROM node:22-bookworm-slim AS build
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl git python3 unzip util-linux \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/

RUN cd agent-node && npm install --include=optional \
  && cd ../agent-network && npm ci

COPY . /workspace
RUN rm -rf /workspace/.git

# 🔴 溯源单独一层 stage（缓存关键）。
# `ARG SOURCE_COMMIT` 在同一 stage 内声明 ⇒ 它之后每一层都进该 ARG 的缓存键；
# 每次构建的 $GITHUB_SHA 都不同 ⇒ apt / 二进制安装层永远 miss。
# 本地实测：单 stage 全量重建 vs 多阶段 10 层 CACHED（0.6s），ENV 语义保留。
FROM build
ARG SOURCE_COMMIT
ENV TEST219_SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["bash", "tests/test219-grok-copresence/run.sh"]
