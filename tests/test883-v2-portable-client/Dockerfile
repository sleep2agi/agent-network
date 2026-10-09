# Test only. No private/local dependency images, host credentials or services.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV npm_config_audit=false npm_config_fund=false PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx && apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl git python3 tmux procps chromium fonts-noto-cjk && rm -rf /var/lib/apt/lists/*

FROM base AS client
# Exact reviewed client revision, not a floating branch or local export.
ENV CLIENT_SOURCE_COMMIT=4500c233e38fbdc2db5932f5edbe92f4fdd1ab9c
WORKDIR /app
RUN git init -q && git remote add origin https://github.com/sleep2agi/agent-network-app.git && git fetch --depth 1 origin "$CLIENT_SOURCE_COMMIT" && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = "$CLIENT_SOURCE_COMMIT"
RUN npm ci --ignore-scripts && npm run typecheck && npx --no-install expo export --platform web --output-dir /client-web

FROM base AS product
WORKDIR /qa-tools
COPY tests/test883-v2-portable-client/tools/package*.json ./
RUN npm ci && ln -s /qa-tools/node_modules/.bin/opencode /usr/local/bin/opencode && test "$(opencode --version)" = 'opencode v2.0.22'
WORKDIR /workspace
COPY server/package*.json ./server/
COPY agent-network/package*.json ./agent-network/
COPY agent-node/package*.json /opt/node_modules/@sleep2agi/agent-node/
RUN cd server && npm ci --ignore-scripts && cd ../agent-network && npm ci --ignore-scripts && cd /opt/node_modules/@sleep2agi/agent-node && npm ci --ignore-scripts
COPY server ./server
COPY agent-network ./agent-network
COPY agent-node /opt/node_modules/@sleep2agi/agent-node
RUN cd /opt/node_modules/@sleep2agi/agent-node && npm run build && chmod 644 package.json && chmod 755 dist/cli.js && chmod -R go-w /opt/node_modules && ln -s /opt/node_modules/@sleep2agi/agent-node/dist/cli.js /usr/local/bin/agent-node
RUN cd agent-network && npm run build && chmod 755 dist/bin/anet.cjs
COPY --from=client /client-web /client-web
COPY --from=client /app/tests/test-layout-sweep/harness.mjs /client-plumbing/harness.mjs
COPY tests/test543-opencode-v2-copresence/stub-model.py /test827/stub-model.py
COPY tests/test883-v2-portable-client /workspace/tests/test883-v2-portable-client
RUN mkdir -p /home/node/test883 /artifacts /run/user/1000 && chown node:node /home/node/test883 /artifacts /run/user/1000 && chmod 700 /run/user/1000
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT \
    CLIENT_SOURCE_COMMIT=4500c233e38fbdc2db5932f5edbe92f4fdd1ab9c \
    ANET_AGENT_NODE_BIN=/opt/node_modules/@sleep2agi/agent-node/dist/cli.js \
    ANET_TMUX_SOCKET=/home/node/test883/tmux.sock \
    TEST829_TMUX_SOCKET=/home/node/test883/tmux.sock \
    TEST829_CLIENT_DRIVER=/workspace/tests/test883-v2-portable-client/create-client.mjs \
    TEST829_MODEL_DRIVER=/workspace/tests/test883-v2-portable-client/model-client.mjs \
    TEST829_LIFECYCLE=1 \
    PLAYWRIGHT_MODULE=/qa-tools/node_modules/playwright/index.mjs
USER node
ENTRYPOINT ["bash", "/workspace/tests/test883-v2-portable-client/run.sh"]
