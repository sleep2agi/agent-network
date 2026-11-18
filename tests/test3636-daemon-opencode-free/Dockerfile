FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN npm install --prefix /opt/private-opencode @opencode/cli@2.0.22 --no-audit --no-fund
WORKDIR /workspace
COPY agent-network/package.json agent-network/package-lock.json agent-network/
COPY agent-node/package.json agent-node/package-lock.json agent-node/
COPY server/package.json server/package-lock.json server/
RUN cd agent-network && bun install --frozen-lockfile --ignore-scripts
RUN cd agent-node && bun install --frozen-lockfile --ignore-scripts
RUN cd server && bun install --frozen-lockfile --ignore-scripts
COPY agent-network agent-network
COPY agent-node agent-node
COPY server server
COPY contracts contracts
COPY tests/test3636-daemon-opencode-free tests/test3636-daemon-opencode-free
RUN cd agent-network && bun run build
RUN mkdir -p /etc/anet-daemon && echo 'ANET_BIN_ABS=/workspace/agent-network/dist/bin/anet.cjs' > /etc/anet-daemon/path.conf
ENV ANET_DAEMON_ALLOW_ENV_BIN=1
ENV ANET_BIN_ABS=/workspace/agent-network/dist/bin/anet.cjs
ENV COMMHUB_DB=/tmp/free-provider-tests.sqlite
CMD ["bash", "tests/test3636-daemon-opencode-free/run.sh"]
