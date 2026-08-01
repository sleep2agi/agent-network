FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates jq unzip && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app/server
COPY server/package.json ./
RUN bun install
COPY server/src ./src

WORKDIR /app
COPY tests/qa-node-04-codex-app-server-reply-routing/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
