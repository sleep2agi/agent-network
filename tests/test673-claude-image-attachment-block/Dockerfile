# test673 — Claude runtime multimodal-wiring gate (issue #259 Y).
#
# Builds from LOCAL source (no npm @preview) and runs the real
# agent-node inbound path against a real hub, with the claude-agent-sdk
# `query` stubbed via `bun --preload` so no vendor/binary is needed.
# See run.sh for the full assertion + witnessed-red mutation.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq procps unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Exact-SHA provenance — pass --build-arg TEST673_SOURCE_COMMIT=$(git rev-parse HEAD)
ARG TEST673_SOURCE_COMMIT=unknown
ENV TEST673_SOURCE_COMMIT=${TEST673_SOURCE_COMMIT}

COPY server /app/server
COPY agent-node /app/agent-node
COPY tests/lib /app/tests/lib
COPY tests/test673-claude-image-attachment-block /app/tests/test673-claude-image-attachment-block
RUN chmod +x /app/tests/test673-claude-image-attachment-block/run.sh

RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent

ENV REPO=/app
CMD ["/app/tests/test673-claude-image-attachment-block/run.sh"]
