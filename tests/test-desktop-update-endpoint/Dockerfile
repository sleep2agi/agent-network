FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/docs-site
COPY docs-site/package.json docs-site/package-lock.json ./
RUN npm ci
COPY docs-site/ ./

CMD ["sh", "-c", "npm run test:update-route && npm run build"]
