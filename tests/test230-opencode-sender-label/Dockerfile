FROM oven/bun:1.3.1

WORKDIR /agent-node-src
COPY agent-node /agent-node-src
# 没有这一行时，镜像里只有源码、没有 node_modules，bun build 会报
#   error: Could not resolve: "zod" ... at /agent-node-src/src/commhub-mcp.ts
# 之所以以前看着是绿的：仓里没有 .dockerignore，构建上下文会把开发者
# 本地 agent-node/node_modules 一起 COPY 进来 —— 也就是说这套件的绿是
# 【借来的】，取决于跑它的人有没有在本地 bun install 过。干净检出必红。
RUN cd /agent-node-src && bun install --frozen-lockfile
COPY tests/test230-opencode-sender-label/run.sh /test230/run.sh
RUN chmod +x /test230/run.sh

CMD ["bash", "/test230/run.sh"]
