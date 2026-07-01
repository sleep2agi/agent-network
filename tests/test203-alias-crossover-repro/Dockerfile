FROM oven/bun:1.3.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl jq ca-certificates sqlite3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY . .
WORKDIR /repo/server
RUN bun install
WORKDIR /repo/agent-node
RUN bun install

WORKDIR /repo
CMD ["bash", "tests/test203-alias-crossover-repro/run.sh"]
