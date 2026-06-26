# Feishu agent — one-command Docker image.
#
# Productized from the live bring-up Vincent + 通信IM马 + 通信龙 ran in
# /tmp/feishu-bringup/. Users `docker compose up -d` against their own
# hub (BYOH) and the entrypoint handles login + node create + channel
# add + start automatically — no manual `docker exec` chain.
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
#
# Versions are intentionally NOT pinned in the Dockerfile — passed via
# build arg so a `bump version → rebuild` flow doesn't require editing
# Dockerfile. Default values point to the latest known-good preview
# (update when promoting a new preview).

FROM node:24-alpine

# Build args — pin EXACT preview versions for reproducible images
# (per 通信龙 2026-06-26: avoid the floating @preview tag so a rebuilt
# image always produces byte-identical artifact). Bump these on the
# next preview ship; users can override via `--build-arg` for hotfix.
ARG ANET_VERSION=2.2.22-preview.2
ARG ANET_NODE_VERSION=2.4.15-preview.2

# bash + curl for entrypoint + diagnostics. tini for PID-1 signal
# forwarding (alpine's default sh as PID 1 leaks SIGTERM → ungraceful
# stop on `docker compose down`).
RUN apk add --no-cache bash curl tini ca-certificates

# Global install both packages. Using `npm i -g @<dist-tag>` keeps the
# Dockerfile pinning by tag (preview) while still being reproducible
# via --build-arg ANET_VERSION=2.4.15-preview.1 (which npm treats as
# either a tag OR a version — version takes precedence when matched).
RUN npm install -g --no-audit --no-fund \
      @sleep2agi/agent-network@${ANET_VERSION} \
      @sleep2agi/agent-node@${ANET_NODE_VERSION} \
  && anet --version

WORKDIR /work

# Entrypoint owns the full bring-up sequence (login → node create →
# channel add → start). Run via tini so `docker compose down` cleanly
# stops the agent (SIGTERM → tini → entrypoint exec'd agent-node).
COPY docker/feishu/entrypoint.sh /usr/local/bin/feishu-entrypoint.sh
RUN chmod +x /usr/local/bin/feishu-entrypoint.sh

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/feishu-entrypoint.sh"]
