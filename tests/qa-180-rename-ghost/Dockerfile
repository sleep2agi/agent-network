# P0 #180 rename ghost reproduction — docker e2e.
#
# Reproduces the reported symptom (rename --force → old claude process
# doesn't die → dashboard ghost). Uses a MOCK 'claude' binary (shell
# script) that emulates the process shape of real claude-code-cli:
#   - Accepts `-n <alias>` argv (matches findNodeProcessesByAlias)
#   - Heart-beats via POST /api/status every 2s (mimics MCP report_status)
#   - Ignores SIGTERM (simulates slow shutdown) unless SIGKILL / --force
#   - Fires a --tmux launch variant to test the tmux code path
#
# No real API key needed — the mock is a pure process-shape fixture that
# exercises anet's kill/verify logic without going through the SDK.
#
# Install path identical to qa-rfc026/qa-rfc027 (local source, no npm
# @preview) per RFC-024 教训.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun-runtime

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq unzip procps tmux \
    build-essential python3 \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# This job runs on every PR and must not depend on the mutable bun.sh installer.
# Copy the reviewed Bun 1.3.14 binary from the same digest-pinned image used by
# the active L1 suites, then fail closed on both bun and bunx versions.
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
    && test "$(bun --version)" = "1.3.14" \
    && test "$(bunx --version)" = "1.3.14"

WORKDIR /app

COPY server /app/server
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network
COPY tests/lib /app/tests/lib
COPY tests/qa-180-rename-ghost/mock-claude /usr/local/bin/claude
COPY tests/qa-180-rename-ghost/run.sh /app/tests/qa-180-rename-ghost/run.sh
RUN chmod +x /usr/local/bin/claude /app/tests/qa-180-rename-ghost/run.sh

RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent && bun run build
RUN cd /app/agent-network && bun install --silent && bun run build

RUN cd /app/agent-node \
    && npm pack \
    && npm install -g ./sleep2agi-agent-node-*.tgz
RUN cd /app/agent-network \
    && npm pack \
    && npm install -g ./sleep2agi-agent-network-*.tgz

RUN anet --version && which anet && which claude

CMD ["/app/tests/qa-180-rename-ghost/run.sh"]
