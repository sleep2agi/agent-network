# TEST-ONLY synthetic credentials; no host state or production connection.
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
COPY tests/test1053-scoped-secrets ./tests/test1053-scoped-secrets
ENV HOME=/tmp/scoped-secrets-test
ENV COMMHUB_DB=/tmp/scoped-secrets1053.db
ENV ANET_DAEMON_ALLOW_ENV_BIN=1
ENV ANET_BIN_ABS=/candidate/agent-network/dist/bin/anet.cjs
RUN bun build agent-network/bin/cli.ts --target=node --outfile=/candidate/agent-network/dist/bin/cli.js --external @sleep2agi/commhub-server --external bun:sqlite --external '../../server/*' && cp agent-network/bin/anet.cjs agent-network/dist/bin/anet.cjs && chmod 755 agent-network/dist/bin/anet.cjs
RUN useradd --create-home --uid 10001 runner
USER runner
CMD ["sh", "tests/test1053-scoped-secrets/run.sh"]
