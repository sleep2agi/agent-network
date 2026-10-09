FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN npm install -g @opencode/cli@2.0.22 && test "$(opencode --version)" = 'opencode v2.0.22'
WORKDIR /workspace
COPY server/package*.json ./server/
COPY agent-node/package*.json /opt/node_modules/@sleep2agi/agent-node/
RUN cd server && npm ci --ignore-scripts && cd /opt/node_modules/@sleep2agi/agent-node && npm ci --ignore-scripts
COPY server ./server
COPY agent-node /opt/node_modules/@sleep2agi/agent-node
COPY tests/test828-opencode-v2-mcp /test828-mcp
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["bash", "/test828-mcp/run.sh"]
