# RFC-028 P1 — provider & model registry + connectivity probe e2e.
# Mirrors qa-rfc026 install pattern (Bookworm + bun + build-essential +
# python3 + sqlite3 + LOCAL source via npm pack + install -g).
#
# Scenarios (see run.sh): A vault write+read / B provider CRUD /
# C probe ok (mock vendor) / D probe auth_fail (mock 401) /
# E SSRF redirect 拒 / F SSRF private-IP 拒 / G secret-no-leak guard.
# Boot tests (separate invocations): I TLS insecure env exit /
# H create-node integration with provider_id.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq unzip procps \
    build-essential python3 \
    sqlite3 openssl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

COPY server /app/server
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network
COPY tests/lib /app/tests/lib
COPY tests/qa-rfc028-provider-probe/run.sh /app/tests/qa-rfc028-provider-probe/run.sh
COPY tests/qa-rfc028-provider-probe/mock-vendor.js /app/tests/qa-rfc028-provider-probe/mock-vendor.js
COPY tests/qa-rfc028-provider-probe/canary.js /app/tests/qa-rfc028-provider-probe/canary.js
RUN chmod +x /app/tests/qa-rfc028-provider-probe/run.sh

RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent && bun run build
RUN cd /app/agent-network && bun install --silent && bun run build

RUN cd /app/agent-node \
    && npm pack \
    && npm install -g ./sleep2agi-agent-node-*.tgz
RUN cd /app/agent-network \
    && npm pack \
    && npm install -g ./sleep2agi-agent-network-*.tgz

RUN anet --version && which anet && which agent-node

CMD ["/app/tests/qa-rfc028-provider-probe/run.sh"]
