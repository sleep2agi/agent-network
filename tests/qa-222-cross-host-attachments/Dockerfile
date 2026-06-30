# Issue #222 — cross-host attachment fetch e2e.
#
# Simulates a "cross-host" scenario inside ONE container: hub's
# uploadsRoot is bound to /srv/hub-uploads (representing the hub
# machine's filesystem); agent's HOME is /home/agent (representing
# a different physical host that cannot read /srv/hub-uploads). The
# agent fetches via HTTP /api/files/<id> using its ntok — proves the
# universal cross-host code path works (no shared FS required).
#
# Install path identical to qa-rfc026 / qa-rfc027 (LOCAL source, no
# npm @preview fallback per RFC-024 教训).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq unzip procps \
    build-essential python3 \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

COPY server /app/server
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network
COPY tests/lib /app/tests/lib
COPY tests/qa-222-cross-host-attachments/run.sh /app/tests/qa-222-cross-host-attachments/run.sh
RUN chmod +x /app/tests/qa-222-cross-host-attachments/run.sh

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

CMD ["/app/tests/qa-222-cross-host-attachments/run.sh"]
