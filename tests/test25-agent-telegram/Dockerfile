FROM oven/bun:1

WORKDIR /app

RUN apt-get update && apt-get install -y curl python3 openssl make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY server/ server/
COPY agent-network/ agent-network/
COPY agent-node/ agent-node/

RUN cd server && bun install
RUN cd agent-network && npm install --ignore-scripts 2>/dev/null || true
RUN cd agent-node && npm install --ignore-scripts 2>/dev/null || true

COPY tests/test25-agent-telegram/run.sh /app/run.sh
RUN chmod +x /app/run.sh

ENV COMMHUB_AUTH_TOKEN=test-auth-token

CMD ["bash", "/app/run.sh"]
