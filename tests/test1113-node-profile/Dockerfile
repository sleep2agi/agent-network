FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e
WORKDIR /pair
COPY deploy/node/task-activity173-139/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY deploy/node/task-activity173-139/verify.mjs ./
CMD ["node", "/pair/verify.mjs", "/pair"]
