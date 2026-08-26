FROM oven/bun:1.2.22
ARG SOURCE_COMMIT
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
ENTRYPOINT ["bash", "/app/run.sh"]
