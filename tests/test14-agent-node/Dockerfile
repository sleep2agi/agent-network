FROM oven/bun:1

WORKDIR /app

RUN apt-get update && apt-get install -y curl python3 make g++ && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

COPY server/ server/
COPY agent-node/ agent-node/

RUN cd server && bun install
RUN cd agent-node && npm install --ignore-scripts 2>/dev/null || true
RUN cd agent-node && npm run build && npm link

COPY tests/test14-agent-node/run.sh /app/run.sh
RUN chmod +x /app/run.sh

ENV COMMHUB_AUTH_TOKEN=test-auth-token

CMD ["bash", "/app/run.sh"]
