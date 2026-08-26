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
ARG TEST203_SOURCE_COMMIT=dev
ENV TEST203_SOURCE_COMMIT=$TEST203_SOURCE_COMMIT

CMD ["bash", "tests/test203-alias-crossover-repro/run.sh"]
