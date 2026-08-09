FROM oven/bun:1.3.14

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl python3 make g++ nodejs npm \
 && rm -rf /var/lib/apt/lists/*

COPY agent-network/ /app/agent-network/
RUN cd /app/agent-network && npm install && npm run build && npm install -g .

COPY server/ /app/server/
RUN cd /app/server && bun install

COPY agent-node/ /app/agent-node/
RUN cd /app/agent-node && npm install && npm run build && npm link

COPY tests/docker-e2e-networks.sh /app/test-networks.sh
COPY tests/docker-config-priority.sh /app/test-config.sh
COPY tests/test639-test-all-v3-fixtures/run.sh /app/run.sh
RUN chmod +x /app/test-networks.sh /app/test-config.sh /app/run.sh

ARG TEST639_SOURCE_COMMIT=unknown
ENV TEST639_SOURCE_COMMIT=$TEST639_SOURCE_COMMIT

CMD ["/app/run.sh"]
