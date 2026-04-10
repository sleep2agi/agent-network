FROM oven/bun:latest

# Install Node.js
RUN apt-get update && apt-get install -y curl python3 && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install anet (global)
RUN npm install -g @sleep2agi/agent-network@latest

# Copy local server + agent-node (V2 dev code)
WORKDIR /app
COPY server/ /app/server/
COPY agent-node/ /app/agent-node/
COPY tests/docker-e2e.sh /app/test.sh
RUN chmod +x /app/test.sh
RUN cd /app/server && bun install

# Install local agent-node globally
RUN cd /app/agent-node && npm install && npm link

# Setup anet config
RUN mkdir -p /root/.anet && \
    echo '{"hub":"http://127.0.0.1:9200"}' > /root/.anet/config.json

CMD ["/app/test.sh"]
