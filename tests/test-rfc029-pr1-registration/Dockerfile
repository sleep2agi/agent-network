# PR① smoke — end-to-end CLI/wizard visibility of the new
# `opencode-cli` runtime + pin-check behavior. No think(), no real
# opencode turn (PR② does that). Two scenarios in one container:
#   A. opencode NOT installed → `anet node start` clear error
#      pointing at `npm install -g opencode-ai@1.17.13`.
#   B. opencode-ai@1.17.13 installed → `assertStartCompatibility`
#      passes, `anet node start` hands off to agent-node which
#      immediately hits the PR① `processTask` stub returning a
#      clear "not yet implemented (RFC-029 PR②)" reply.

FROM oven/bun:1.3.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl jq ca-certificates procps sqlite3 nodejs npm && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY . .

# Pre-build agent-network + install deps for the local invocation.
WORKDIR /repo/agent-network
RUN bun install --silent
WORKDIR /repo/agent-node
RUN bun install --silent
WORKDIR /repo/server
RUN bun install --silent

WORKDIR /repo
RUN chmod +x /repo/tests/test-rfc029-pr1-registration/run.sh
CMD ["bash", "/repo/tests/test-rfc029-pr1-registration/run.sh"]
