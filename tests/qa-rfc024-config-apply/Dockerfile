# RFC-024 §7.2 — config-apply Docker e2e. Spawns a real hub + real
# agent-node + real `anet node start` (under W1 supervisor) in one
# container, drives the MCP tools as a mock dashboard would, and
# asserts the end-to-end restart-finalize chain.
#
# CRITICAL — per 通信龙 catch on the prior cut, this image MUST install
# `anet` + `agent-node` from the LOCAL source under test (NOT a
# published npm tag). Otherwise launchAgent's `cmd = "agent-node"` PATH
# lookup falls through to `npx -y @sleep2agi/agent-node@preview` which
# fetches the wrong (published) bits, and the under-test W1 supervisor
# never actually runs.
#
# Bookworm (not alpine) — agent-node's claude-agent-sdk binary is glibc
# only (per the 2026-06-26 alpine catch). Bun installed via the
# standard installer; unzip needed by the bun installer per same
# incident.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq unzip procps sqlite3 \
    build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Copy the LOCAL source trees from this branch so the test exercises
# the exact code under review (NOT a published npm tag). The hub side
# is `server/`, the node-runtime side is `agent-node/`, and the
# launchAgent + W1 supervisor under test live in `agent-network/`.
COPY server /app/server
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network
# Mirror the repo tree layout so the run.sh relative source-path
# `../lib/safe-rm.sh` resolves cleanly.
COPY tests/lib /app/tests/lib
COPY tests/qa-rfc024-config-apply/run.sh /app/tests/qa-rfc024-config-apply/run.sh
RUN chmod +x /app/tests/qa-rfc024-config-apply/run.sh

# Install deps so build + npm-pack don't have to.
RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent && bun run build
# agent-network's build script includes obfuscator + tsc; the obfuscator
# is dev-only and not required for run-time, so we install --production-
# style by running the bun build step but skipping the obfuscator chain
# is hard to do clean — easier to run the full build. The script is
# defined in agent-network/package.json `build`.
RUN cd /app/agent-network && bun install --silent && bun run build

# npm-pack the LOCAL trees + install globally so `anet` and
# `agent-node` resolve from this branch's source, NOT from npm. Order
# matters: agent-node must be globally installed BEFORE agent-network
# so launchAgent's `which agent-node` finds it (otherwise launchAgent
# falls through to its `npx @preview` fallback path).
RUN cd /app/agent-node \
    && npm pack \
    && npm install -g ./sleep2agi-agent-node-*.tgz
RUN cd /app/agent-network \
    && npm pack \
    && npm install -g ./sleep2agi-agent-network-*.tgz

# Verify the install: anet --version should report the local versions.
RUN anet --version && which anet && which agent-node

CMD ["/app/tests/qa-rfc024-config-apply/run.sh"]
