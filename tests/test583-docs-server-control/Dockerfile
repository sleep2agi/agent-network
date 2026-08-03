FROM node:22-bookworm-slim
WORKDIR /docs
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY docs-site/package.json docs-site/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY docs-site/ ./
RUN npm run build
