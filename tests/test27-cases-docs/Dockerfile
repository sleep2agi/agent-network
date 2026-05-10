FROM oven/bun:1

WORKDIR /app

RUN apt-get update && apt-get install -y curl python3 ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

COPY docs-site/package*.json docs-site/
RUN cd docs-site && npm ci

COPY agent-network/package*.json agent-network/
RUN cd agent-network && npm ci --omit=dev --ignore-scripts

COPY docs-site/ docs-site/
COPY agent-network/ agent-network/
COPY demos/ demos/
COPY tests/test27-cases-docs/run.sh /app/run.sh

RUN chmod +x /app/run.sh

CMD ["bash", "/app/run.sh"]
