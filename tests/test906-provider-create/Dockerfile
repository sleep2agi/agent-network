# TEST ONLY: local credential initialization + actual pinned CLI, before launch.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /work
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && npm ci --ignore-scripts --no-audit --no-fund
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
RUN cd agent-node && npm ci --ignore-scripts --no-audit --no-fund
COPY agent-network ./agent-network
COPY agent-node ./agent-node
COPY server/src ./server/src
RUN cd agent-network && ./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler src/daemon-provider-initialize.ts
RUN cd agent-network && bun build bin/cli.ts --target node --outfile dist/bin/cli.js --external @sleep2agi/commhub-server --external bun:sqlite --external '../../server/*'
COPY --chmod=755 agent-network/bin/anet.cjs /work/agent-network/dist/bin/anet.cjs
RUN chmod go-w /work /work/agent-network /work/agent-network/dist /work/agent-network/dist/bin
RUN useradd --create-home --uid 10001 runner
USER runner
ENV ANET_BIN_ABS=/work/agent-network/dist/bin/anet.cjs ANET_DAEMON_ALLOW_ENV_BIN=1
CMD ["bun", "test", "--bail", "agent-network/src/daemon-provider-initialize.test.ts"]
