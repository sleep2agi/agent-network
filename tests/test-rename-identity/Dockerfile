# PR-5 #146 rename family 14-case Docker matrix
# Builds main HEAD source (post-merge of PR-1+2+3+4 — 4 PRs containing all
# rename/identity fixes) so the 14 cases verify the FAMILY-LEVEL behavior,
# not preview/latest npm artifacts.
#
# Stack (built from /app/* source):
#   - @sleep2agi/agent-network  (PR-3 e0aa4d8: local-only rename, codex/grok proc match)
#   - @sleep2agi/agent-node     (PR-4 2e9fae0: ALIAS getter + #213 node_id query)
#   - @sleep2agi/commhub-server (PR-1+2 2dc166c: node_id Map / send_message canonical /
#                                node_id columns / list_tasks from_node_id / node_local_only)
FROM oven/bun:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl python3 make g++ jq sqlite3 procps expect tmux unzip ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm --version && node --version && \
    rm -rf /var/lib/apt/lists/*

# Build agent-network (CLI) from source — main HEAD with PR-3 merged
COPY agent-network/ /app/agent-network/
RUN cd /app/agent-network && npm install --no-audit --no-fund && npm run build && npm install -g .

# Build agent-node (runtime) from source — main HEAD with PR-4 merged
COPY agent-node/ /app/agent-node/
RUN cd /app/agent-node && npm install --no-audit --no-fund && npm run build && npm link
RUN cd /app/agent-node && npm install @openai/codex-sdk 2>/dev/null || true

# commhub-server source — main HEAD with PR-1+2 merged
COPY server/ /app/server/
RUN cd /app/server && bun install --silent

# Fake grok binary for grok-build-acp runtime cases (no xAI key needed)
COPY tests/test-rename-identity/lib/fake-grok /usr/local/bin/fake-grok
RUN chmod +x /usr/local/bin/fake-grok && ln -sf /usr/local/bin/fake-grok /usr/local/bin/grok

# Shared lib + cases mounted at /harness (read-only)
COPY tests/test-rename-identity/lib /harness/lib
COPY tests/test-rename-identity/cases /harness/cases
COPY tests/test-rename-identity/run-case.sh /harness/run-case.sh
COPY tests/test-rename-identity/run-all.sh  /harness/run-all.sh
RUN chmod +x /harness/run-case.sh /harness/run-all.sh /harness/lib/*.sh /harness/cases/*.sh 2>/dev/null || true

RUN mkdir -p /artifacts && chmod 0777 /artifacts
WORKDIR /work

# Default: run-all. Override via `docker run ... /harness/run-case.sh N`.
CMD ["/harness/run-all.sh"]
