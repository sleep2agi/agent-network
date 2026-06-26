# Feishu agent — one-command Docker image.
#
# Base + deps are intentionally NOT `node:24-alpine`. Why:
#   1. `@anthropic-ai/claude-agent-sdk-linux-x64` ships a glibc binary;
#      alpine's musl libc can't load it (`agent-node` resolves to that
#      binary on Linux x64 unless a system `claude` is on PATH). Image
#      would boot fine but every think() call would fail to spawn.
#   2. `node-pty` (transitive on some channel paths) needs build-essential
#      + python3 for node-gyp on first install.
#   3. Both `agent-network` and `agent-node` publish flow uses `bun` for
#      a few internal scripts; agent-node also reads `bun` via the
#      claude SDK plugin path on certain channels.
# Same base IM马's manual `/tmp/feishu-bringup/Dockerfile` used for the
# live vAgent that 通信龙 + Vincent verified end-to-end — proven runtime.
#
# Build (from repo root):
#   docker build -t anet-feishu:latest \
#     --build-arg ANET_VERSION=<preview-version> \
#     --build-arg ANET_NODE_VERSION=<preview-version> \
#     -f docker/feishu/Dockerfile .
#
# Run:
#   cd docker/feishu/
#   cp .env.example .env && $EDITOR .env       # fill HUB_USER/PASSWORD + FEISHU_* + ANET_MODEL + ANTHROPIC_*
#   docker compose up -d                       # connects to your own hub (HUB_URL in .env)

FROM node:22-bookworm-slim

# Pinned exact preview versions for reproducible images (per 通信龙
# 2026-06-26 — avoid the floating @preview tag). Bump these on the
# next preview ship; users can override via --build-arg for hotfix.
ARG ANET_VERSION=2.2.22-preview.2
ARG ANET_NODE_VERSION=2.4.15-preview.2

ENV DEBIAN_FRONTEND=noninteractive

# Core runtime deps:
#   - build-essential + python3 → node-gyp builds (node-pty etc.)
#   - curl + ca-certificates    → bun installer + outbound HTTPS
#   - tini                      → PID-1 signal forwarder (clean
#                                 `docker compose down`)
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 \
      curl ca-certificates unzip \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Install bun (required by agent-network + agent-node tooling paths).
RUN curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    bun --version

# Global install both packages at the pinned preview versions.
RUN npm install -g --no-audit --no-fund \
      @sleep2agi/agent-network@${ANET_VERSION} \
      @sleep2agi/agent-node@${ANET_NODE_VERSION} \
  && anet --version

WORKDIR /work

# Entrypoint owns the full bring-up sequence. Tini as PID 1 means
# `docker compose down`'s SIGTERM reaches the agent cleanly (vs alpine
# `sh` PID 1 which leaks signals → ungraceful stop).
COPY docker/feishu/entrypoint.sh /usr/local/bin/feishu-entrypoint.sh
RUN chmod +x /usr/local/bin/feishu-entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/feishu-entrypoint.sh"]
