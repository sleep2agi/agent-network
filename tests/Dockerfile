FROM oven/bun:latest

# Install Node.js
RUN apt-get update && apt-get install -y curl python3 && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install anet + agent-node
RUN npm install -g @sleep2agi/agent-network@1.3.3 @sleep2agi/agent-node@2.0.0

# Copy server + test script
WORKDIR /app
COPY server/ /app/server/
COPY tests/docker-e2e.sh /app/test.sh
RUN chmod +x /app/test.sh
RUN cd /app/server && bun install

# Setup anet config
RUN mkdir -p /root/.anet && \
    echo '{"hub":"http://127.0.0.1:9200"}' > /root/.anet/config.json

CMD ["/app/test.sh"]
