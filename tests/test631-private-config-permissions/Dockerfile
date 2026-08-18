FROM oven/bun:1.3.14
WORKDIR /work
COPY agent-network/src ./agent-network/src
COPY agent-network/bin ./agent-network/bin
# 🔴 必须和 agent-node/src 一起拷 —— `agent-node/src/cli.ts` 里有
#     import agentNodePackage from "../package.json";   （#1019）
#   bun build 在**构建期**内联它；只拷 src 会让 `bun build src/cli.ts` 直接失败：
#     error: Could not resolve: "../package.json"
#   本仓 16 个会构建 cli.ts 的镜像里，14 个本来就拷了它，这是补齐剩下的。
COPY agent-node/package.json ./agent-node/package.json
COPY agent-node/src ./agent-node/src
COPY tests/test631-private-config-permissions/run.sh /run.sh
ARG TEST631_SOURCE_COMMIT=unknown
ENV TEST631_SOURCE_COMMIT=$TEST631_SOURCE_COMMIT
RUN chmod 0755 /run.sh
ENTRYPOINT ["/run.sh"]
