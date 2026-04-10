FROM oven/bun:latest

# Install Node.js
RUN apt-get update && apt-get install -y curl python3 && \
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
RUN chmod +x /app/test.sh /app/test-codex.sh
RUN cd /app/server && bun install

# Install local agent-node globally (build from source)
RUN cd /app/agent-node && npm install && npm run build && npm link

# Setup anet config
RUN mkdir -p /root/.anet && \
    echo '{"hub":"http://127.0.0.1:9200"}' > /root/.anet/config.json

CMD ["/app/test.sh"]
