FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates jq unzip && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app/server
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile
COPY server/src ./src

WORKDIR /app
COPY tests/qa-hub-11-node-delete-sse/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
