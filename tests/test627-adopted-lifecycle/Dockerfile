FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ procps tmux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /root/.bun/bin/bun
ENV PATH="/root/.bun/bin:${PATH}"
WORKDIR /app
COPY server ./server
COPY agent-node ./agent-node
COPY agent-network ./agent-network
RUN cd server && bun install --frozen-lockfile
RUN cd agent-node && bun install --frozen-lockfile && bun run build && chmod 755 dist/cli.js \
    && ln -s /app/agent-node/dist/cli.js /usr/local/bin/agent-node
# Container-only source artifacts; no registry, Release or host installation.
RUN cd agent-network && bun install --frozen-lockfile \
    && bun build bin/cli.ts --outfile dist/bin/cli.js --target node --external @sleep2agi/commhub-server --external bun:sqlite \
    && cp bin/anet.cjs dist/bin/anet.cjs && chmod 755 dist/bin/anet.cjs
COPY tests/test627-adopted-lifecycle ./tests/test627-adopted-lifecycle
CMD ["bash", "/app/tests/test627-adopted-lifecycle/run.sh"]
