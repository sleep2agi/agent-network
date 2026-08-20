ARG SOURCE_COMMIT
FROM node:22-bookworm-slim
ARG SOURCE_COMMIT
ENV TEST750_SOURCE_COMMIT=$SOURCE_COMMIT
# Pinned bun, per the ratchet in .github/scripts/check-bun-install-pin.py.
# Version + checksum copied from tests/test725-agent-node-unit-ci/Dockerfile.
# 🔴 ENV, not ARG. The hub-orphan-gates job auto-detects every `^ARG NAME` in
#    the Dockerfile and passes `--build-arg NAME=$GITHUB_SHA` for each — which
#    would set BUN_VERSION and the checksum to a commit sha and break the pinned
#    download. Only SOURCE_COMMIT wants that treatment.
ENV BUN_VERSION=1.3.14
ENV BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git python3 tmux unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl --fail --silent --show-error --location \
      --retry 3 --retry-delay 2 --retry-all-errors \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
      --output /tmp/bun-linux-x64.zip \
  && echo "${BUN_LINUX_X64_SHA256}  /tmp/bun-linux-x64.zip" | sha256sum --check --strict \
  && unzip -j /tmp/bun-linux-x64.zip 'bun-linux-x64/bun' -d /usr/local/bin \
  && chmod 0755 /usr/local/bin/bun \
  && test "$(bun --version)" = "$BUN_VERSION" \
  && rm -f /tmp/bun-linux-x64.zip
# 🔴 The release zip ships bun WITHOUT bunx, and `anet hub start` spawns
#    commhub-server through bunx specifically (#766). Without this symlink the
#    dependency preflight correctly refuses to start — which is how this line
#    came to be needed: the suite went red the moment that preflight learned the
#    real requirement.
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

WORKDIR /workspace
COPY server/package.json server/package-lock.json ./server/
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
# --ignore-scripts: this suite drives the CLI's create/start decision paths and
# never opens a PTY, so node-pty's native build is dead weight here. If the CLI
# ever needs it at import time this build fails loudly rather than silently.
RUN cd server && npm ci --ignore-scripts \
 && cd ../agent-network && npm ci --ignore-scripts

# A codex stub. It exists so `commandExists("codex")` passes and the launcher
# runs far enough to PRINT the sandbox it resolved — which is the only place
# that decision is observable from outside. It never binds, so the launcher
# fails right after; the suite asserts on the line, not on the outcome.
#
# 🔴 Why this matters: an earlier version of this image left tmux out and used
#    the "requires tmux" guard as its signal. That exits BEFORE the sandbox is
#    computed (guard at cli.ts ~:495, posture at ~:664), so a mutation making
#    co-presence unconditionally danger-full-access passed the suite. The
#    security-relevant assertion needs the launcher to get past the guards.
RUN printf '%s\n' '#!/bin/sh' 'echo "codex-cli 0.0.0-test750-stub"' 'sleep 3600' \
      > /usr/local/bin/codex \
  && chmod 0755 /usr/local/bin/codex

COPY . /workspace
RUN rm -rf /workspace/.git /workspace/.anet

ENTRYPOINT ["bash", "tests/test750-codex-copresence-onecommand/run.sh"]
