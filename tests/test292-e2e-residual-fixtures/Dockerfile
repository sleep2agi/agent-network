FROM oven/bun:1.3.14

RUN apt-get update && apt-get install -y curl jq python3 make g++ procps && \
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

COPY tests/lib/ /app/lib/
COPY tests/docker-e2e-networks.sh /app/test-networks.sh
COPY tests/docker-e2e-loop-runtime.sh /app/test-loop-runtime.sh
COPY tests/docker-e2e-loop-npm-pack.sh /app/test-loop-npm-pack.sh
COPY tests/docker-e2e-loop-self-mgmt.sh /app/test-loop-self-mgmt.sh
COPY tests/test292-e2e-residual-fixtures/run.sh /app/test292-residual.sh
RUN chmod +x /app/test-networks.sh /app/test-loop-runtime.sh \
  /app/test-loop-npm-pack.sh /app/test-loop-self-mgmt.sh /app/test292-residual.sh

ARG TEST292_RESIDUAL_SOURCE_COMMIT=unknown
ENV TEST292_RESIDUAL_SOURCE_COMMIT=${TEST292_RESIDUAL_SOURCE_COMMIT}

ENTRYPOINT ["bash", "/app/test292-residual.sh"]
