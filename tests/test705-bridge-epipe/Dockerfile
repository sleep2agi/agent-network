FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
ENV SOURCE_COMMIT=$SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
WORKDIR /repo
RUN apt-get update -qq && apt-get install -y --no-install-recommends coreutils bash python3 make g++ >/dev/null && rm -rf /var/lib/apt/lists/*
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
RUN cd agent-node && bun install --frozen-lockfile
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && bun install --frozen-lockfile
COPY agent-node ./agent-node
COPY agent-network ./agent-network
COPY tests/test705-bridge-epipe/run.sh ./run.sh
COPY tests/test705-bridge-epipe/mutation.mjs ./mutation.mjs
RUN chmod 0755 ./run.sh

# 🔴 溯源单独一层 stage（缓存关键）。
# `ARG SOURCE_COMMIT` 在 stage 内声明（哪怕没人引用它）也会让它之后每一层进入该 ARG 的缓存键；
# 每次构建的 $GITHUB_SHA 都不同 ⇒ 前面的 RUN 层永远 miss（本地实测 146.5s vs 0.6s）。
FROM build
ARG SOURCE_COMMIT
ENTRYPOINT ["./run.sh"]
