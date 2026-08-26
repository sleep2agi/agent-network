FROM oven/bun:1.2.22-debian

RUN apt-get update && apt-get install -y --no-install-recommends bash curl jq ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package.json ./
RUN bun install --frozen-lockfile
COPY server/src ./src

WORKDIR /app
COPY tests/test1210-actual-target-contract/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
