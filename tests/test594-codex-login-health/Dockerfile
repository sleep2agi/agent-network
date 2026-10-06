FROM oven/bun:1.3.14

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl jq procps ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ARG TEST594_SOURCE_COMMIT=unknown
ENV TEST594_SOURCE_COMMIT=${TEST594_SOURCE_COMMIT}

COPY server/package.json server/bun.lock* ./server/
RUN cd server && bun install --frozen-lockfile --ignore-scripts
COPY agent-node/package.json ./agent-node/
RUN cd agent-node && bun install --ignore-scripts

COPY server /app/server
COPY agent-node /app/agent-node
COPY tests/lib /app/tests/lib
COPY tests/test594-codex-login-health /app/tests/test594-codex-login-health
RUN chmod +x /app/tests/test594-codex-login-health/run.sh

CMD ["/app/tests/test594-codex-login-health/run.sh"]
