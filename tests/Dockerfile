FROM oven/bun:latest

# Install Node.js
RUN apt-get update && apt-get install -y curl python3 make g++ jq && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install local anet (V2 dev code)
COPY agent-network/ /app/agent-network/
RUN cd /app/agent-network && npm install && npm run build && npm install -g .

# Copy local server + agent-node (V2 dev code)
WORKDIR /app
COPY server/ /app/server/
COPY agent-node/ /app/agent-node/
COPY tests/docker-e2e.sh /app/test.sh
COPY tests/docker-e2e-codex.sh /app/test-codex.sh
COPY tests/docker-e2e-claude-sdk.sh /app/test-claude.sh
COPY tests/docker-idiom-game.sh /app/test-game.sh
COPY tests/docker-e2e-minimax.sh /app/test-minimax.sh
COPY tests/docker-mixed-game.sh /app/test-mixed.sh
COPY tests/test-all.sh /app/test-all.sh
COPY tests/docker-config-priority.sh /app/test-config.sh
COPY tests/demo-quickstart.sh /app/demo.sh
COPY tests/docker-e2e-auth.sh /app/test-auth.sh
COPY tests/docker-e2e-networks.sh /app/test-networks.sh
COPY tests/docker-e2e-loop-runtime.sh /app/test-loop-runtime.sh
COPY tests/docker-e2e-loop-npm-pack.sh /app/test-loop-npm-pack.sh
COPY tests/docker-e2e-loop-self-mgmt.sh /app/test-loop-self-mgmt.sh
COPY tests/lib /app/lib
RUN chmod +x /app/test.sh /app/test-codex.sh /app/test-claude.sh /app/test-game.sh /app/test-config.sh /app/test-minimax.sh /app/test-all.sh /app/demo.sh /app/test-auth.sh /app/test-networks.sh /app/test-loop-runtime.sh /app/test-loop-npm-pack.sh /app/test-loop-self-mgmt.sh
RUN cd /app/server && bun install

# Install local agent-node globally (build from source)
RUN cd /app/agent-node && npm install && npm run build && npm link
# Ensure codex-sdk is resolvable by agent-node's dynamic import
RUN cd /app/agent-node && npm install @openai/codex-sdk 2>/dev/null || true

# Setup anet config
RUN mkdir -p /root/.anet && \
    echo '{"hub":"http://127.0.0.1:9200"}' > /root/.anet/config.json

CMD ["/app/test.sh"]
