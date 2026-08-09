FROM oven/bun:1.3.14

RUN apt-get update && apt-get install -y curl jq python3 make g++ && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

COPY agent-network/ /app/agent-network/
RUN cd /app/agent-network && npm install && npm run build && npm install -g .

COPY server/ /app/server/
RUN cd /app/server && bun install

COPY agent-node/ /app/agent-node/
RUN cd /app/agent-node && npm install && npm run build && npm link && \
    npm install @openai/codex-sdk 2>/dev/null || true

ARG TEST292_L2_SOURCE_COMMIT=unknown
ENV TEST292_L2_SOURCE_COMMIT=${TEST292_L2_SOURCE_COMMIT}

COPY tests/docker-e2e.sh /app/test.sh
COPY tests/lib/ /app/lib/
COPY tests/test292-e2e-agent-registration/run.sh /app/run.sh
RUN chmod +x /app/run.sh

ENTRYPOINT ["bash", "/app/run.sh"]
