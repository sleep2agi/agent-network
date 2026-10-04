ARG SOURCE_COMMIT
FROM node:22-bookworm-slim
# #533 — real `anet attach` against real tmux 3.3a on a PRIVATE socket, LANG=C,
# CJK session name. The prefix up to `npm ci` is byte-identical to
# tests/test745-agent-network-unit-ci/Dockerfile so the same CI job reuses that
# layer cache instead of paying a second cold dependency install.
ENV npm_config_audit=false npm_config_fund=false
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl git python3 unzip util-linux \
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

WORKDIR /workspace
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && npm ci

# Only now diverge from test745: tmux, then the sources.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux \
  && rm -rf /var/lib/apt/lists/*

COPY agent-node/package.json ./agent-node/package.json
COPY agent-node/src ./agent-node/src
COPY agent-network ./agent-network
COPY channel ./channel
COPY tests/test533-tmux-format-locale ./tests/test533-tmux-format-locale

ARG SOURCE_COMMIT
ENV TEST533_SOURCE_COMMIT=$SOURCE_COMMIT
RUN chown -R node:node /workspace
USER node

ENTRYPOINT ["bash", "tests/test533-tmux-format-locale/run.sh"]
