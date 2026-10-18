# TEST-ONLY synthetic credentials; independent node, no production connection.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /candidate
COPY agent-network/package*.json ./agent-network/
COPY agent-node/package*.json ./agent-node/
COPY server/package*.json ./server/
RUN cd agent-network && npm ci --ignore-scripts --no-audit --no-fund && cd ../agent-node && npm ci --ignore-scripts --no-audit --no-fund && cd ../server && npm ci --ignore-scripts --no-audit --no-fund
RUN ln -s /candidate/server/node_modules /candidate/node_modules
COPY agent-network ./agent-network
COPY agent-node ./agent-node
COPY server ./server
COPY tests/test1075-node-secrets ./tests/test1075-node-secrets
ENV HOME=/tmp/node-secrets1075-fixture
ENV COMMHUB_DB=/tmp/test1075-node-secrets.db
RUN useradd --create-home --uid 10001 fixture
USER fixture
CMD ["sh","tests/test1075-node-secrets/run.sh"]
