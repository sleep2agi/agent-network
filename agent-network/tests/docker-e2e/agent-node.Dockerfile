# Pre-bake agent-node + its peer deps so startup is fast.
FROM node:20-alpine

WORKDIR /app

# Install agent-node + the optional peer it picks up under runtime=http
# (none required — http-api uses native fetch). Pinning the version
# keeps the test stack reproducible.
RUN npm install --no-audit --no-fund --silent \
    @sleep2agi/agent-node@2.1.0-preview.13

# The CLI entry point. We invoke it via `node` to avoid an extra npx
# resolve round-trip.
ENV NODE_ENV=production

WORKDIR /work
# Default command is overridden by docker-compose.yml — kept here for
# `docker run` debug usage.
CMD ["node", "/app/node_modules/@sleep2agi/agent-node/dist/cli.js", "--help"]
