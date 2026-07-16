# RFC-029 PR③ — preset materialization + upgrade-pin smoke.
#
# End-to-end docker: bun runs the branch source `anet node create`
# with runtime=opencode-cli + preset=anthropic + ANTHROPIC_API_KEY
# env set. Asserts auth.json + opencode.json land under the node
# HOME with mode 0o600.
#
# Also verifies `anet opencode upgrade-pin <version>` refuses to
# write the pin when the version's smoke fails (we point at a
# nonexistent binary path via a shim that will exit non-zero).

FROM oven/bun:1.3.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl jq ca-certificates procps sqlite3 nodejs npm \
      python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY . .
WORKDIR /repo/agent-network
RUN bun install --silent
WORKDIR /repo/agent-node
RUN bun install --silent

WORKDIR /repo
RUN chmod +x /repo/tests/test-rfc029-pr3-preset/run.sh
CMD ["bash", "/repo/tests/test-rfc029-pr3-preset/run.sh"]
