FROM oven/bun:1.3.14 AS bun
FROM node:22-bookworm-slim
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT npm_config_audit=false npm_config_fund=false
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx && apt-get update && \
    apt-get install -y --no-install-recommends bash ca-certificates curl python3 tmux procps && \
    rm -rf /var/lib/apt/lists/*
ENV OPENCODE_V2_VERSION=2.0.22
RUN npm install -g "@opencode/cli@${OPENCODE_V2_VERSION}" && \
    test "$(opencode --version)" = "opencode v${OPENCODE_V2_VERSION}"
WORKDIR /workspace
COPY server/package*.json ./server/
COPY agent-network/package*.json ./agent-network/
COPY agent-node/package*.json /opt/node_modules/@sleep2agi/agent-node/
RUN cd server && npm ci --ignore-scripts && \
    cd ../agent-network && npm ci --ignore-scripts && \
    cd /opt/node_modules/@sleep2agi/agent-node && npm ci --ignore-scripts
COPY server ./server
COPY agent-network ./agent-network
COPY agent-node /opt/node_modules/@sleep2agi/agent-node
RUN cd /opt/node_modules/@sleep2agi/agent-node && npm run build && chmod 755 dist/cli.js && \
    chmod -R go-w /opt/node_modules
COPY tests/test543-opencode-v2-copresence/stub-model.py /test827/stub-model.py
COPY tests/test827-opencode-v2-hub /test827
ENV ANET_AGENT_NODE_BIN=/opt/node_modules/@sleep2agi/agent-node/dist/cli.js
ENV ANET_TMUX_SOCKET=/run/test827-tmux.sock
ENTRYPOINT ["bash", "/test827/run.sh"]
