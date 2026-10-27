ARG SOURCE_COMMIT
FROM node:22-bookworm-slim AS build
# board #738 — real codex 0.133.0 (pre-ordinal) and 0.159.2 (paginated rollouts, thread/fork) + bun.
ENV npm_config_audit=false npm_config_fund=false
# Pinned bun, per .github/scripts/check-bun-install-pin.py (same pin as test720/test750).
# 🔴 ENV, not ARG: hub-orphan-gates passes --build-arg NAME=$GITHUB_SHA for every ARG.
ENV BUN_VERSION=1.3.14
ENV BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git unzip python3 tmux procps \
  && rm -rf /var/lib/apt/lists/*
RUN curl --fail --silent --show-error --location \
      --retry 3 --retry-delay 2 --retry-all-errors \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
      --output /tmp/bun-linux-x64.zip \
  && echo "${BUN_LINUX_X64_SHA256}  /tmp/bun-linux-x64.zip" | sha256sum --check --strict \
  && unzip -j /tmp/bun-linux-x64.zip 'bun-linux-x64/bun' -d /usr/local/bin \
  && chmod 0755 /usr/local/bin/bun \
  && test "$(bun --version)" = "$BUN_VERSION" \
  && rm -f /tmp/bun-linux-x64.zip
RUN npm install -g --prefix /opt/codex-0.133.0 @openai/codex@0.133.0 \
 && npm install -g --prefix /opt/codex-0.159.2 @openai/codex@0.159.2 \
 && /opt/codex-0.133.0/bin/codex --version | grep -Fx 'codex-cli 0.133.0' \
 && /opt/codex-0.159.2/bin/codex --version | grep -Fx 'codex-cli 0.159.2'
# 🔴 The release zip ships bun WITHOUT bunx; `anet hub start` paths spawn through bunx (#766).
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
WORKDIR /workspace
COPY server/package.json server/package-lock.json ./server/
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd server && npm ci --ignore-scripts \
 && cd ../agent-network && npm ci --ignore-scripts
COPY . /workspace
RUN rm -rf /workspace/.git /workspace/.anet

# 🔴 溯源单独一层 stage（缓存关键）。
# `ARG SOURCE_COMMIT` 在**同一 stage 内**声明，会让它之后每一层都进入该 ARG 的缓存键；
# 每次构建传的 $GITHUB_SHA 都不同 ⇒ apt 与两个 ~150MB codex 二进制安装层永远 miss。
# 本地实测（仅改 --build-arg SOURCE_COMMIT）：
#   单 stage        : apt 22.6s / codex 26.1s 全部重建
#   多阶段（本写法）: 全部 CACHED，第二次构建累计 0.6s
FROM build
ARG SOURCE_COMMIT
ENV T738_SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["bash", "tests/test738-codex-fork-on-resume-failure/run.sh"]
