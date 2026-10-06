# Board #673. Real hub + real cli.ts processWithClaude. The SDK query is
# stubbed (mock upstream) so the turn does not need a Claude binary.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG QA_BOARD673_SOURCE_COMMIT=unknown
ENV QA_BOARD673_SOURCE_COMMIT=${QA_BOARD673_SOURCE_COMMIT}

COPY server /app/server
COPY agent-node /app/agent-node
COPY tests/lib /app/tests/lib
COPY tests/qa-board673-claude-process-auth /app/tests/qa-board673-claude-process-auth
RUN chmod +x /app/tests/qa-board673-claude-process-auth/run.sh

RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent

ENV REPO=/app
CMD ["/app/tests/qa-board673-claude-process-auth/run.sh"]
