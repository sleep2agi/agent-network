FROM oven/bun:1.2.22 AS build
ENV TEST225_STOP_SOURCE_COMMIT=$SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ procps tmux && rm -rf /var/lib/apt/lists/*
COPY agent-network/ agent-network/
COPY agent-node/ agent-node/
RUN cd agent-node && bun install --ignore-scripts && bun run build && ln -s /app/agent-node/dist/cli.js /usr/local/bin/agent-node
RUN cd agent-network && bun install --ignore-scripts && bun run build && ln -s /app/agent-network/bin/anet.cjs /usr/local/bin/anet
COPY tests/test225-node-stop-convergence/run.sh /app/run.sh
RUN chmod 0755 /app/run.sh

# 🔴 溯源单独一层 stage（缓存关键）。
# `ARG SOURCE_COMMIT` 在 stage 内声明（哪怕没人引用它）也会让它之后每一层进入该 ARG 的缓存键；
# 每次构建的 $GITHUB_SHA 都不同 ⇒ 前面的 RUN 层永远 miss（本地实测 146.5s vs 0.6s）。
FROM build
ARG SOURCE_COMMIT
ENTRYPOINT ["bash", "/app/run.sh"]
