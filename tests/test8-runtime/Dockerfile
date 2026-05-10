FROM oven/bun:1

WORKDIR /app

RUN apt-get update && apt-get install -y curl python3 make g++ && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

COPY server/ server/
COPY agent-network/ agent-network/
COPY agent-node/ agent-node/

RUN cd server && bun install
RUN cd agent-network && npm install --ignore-scripts 2>/dev/null || true
RUN cd agent-node && npm install --ignore-scripts 2>/dev/null || true
RUN cd agent-network && npm run build && npm install -g .
RUN cd agent-node && npm run build && npm link
RUN cd agent-node && npm install @openai/codex-sdk 2>/dev/null || true
RUN mkdir -p /root/.anet && echo '{"hub":"http://127.0.0.1:9200","token":"test-auth-token"}' > /root/.anet/config.json

COPY tests/test8-runtime/run.sh /app/run.sh
RUN chmod +x /app/run.sh

ENV COMMHUB_AUTH_TOKEN=test-auth-token

CMD ["bash", "/app/run.sh"]
