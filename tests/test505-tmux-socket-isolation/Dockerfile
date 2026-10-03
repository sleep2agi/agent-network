FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
# #505 — real tmux, real default server, real inherited $TMUX. The helper is
# node-builtins only, so no npm install: this image is tmux + bun + two files.
ENV npm_config_audit=false npm_config_fund=false

ARG SOURCE_COMMIT
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl procps tmux unzip \
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
RUN chown node:node /workspace
USER node
COPY --chown=node:node agent-network/src/tmux.ts ./agent-network/src/tmux.ts
COPY --chown=node:node agent-node/src/tmux.ts ./agent-node/src/tmux.ts
COPY --chown=node:node tests/test505-tmux-socket-isolation ./tests/test505-tmux-socket-isolation

ARG SOURCE_COMMIT
ENV TEST505_SOURCE_COMMIT=$SOURCE_COMMIT

ENTRYPOINT ["bash", "tests/test505-tmux-socket-isolation/run.sh"]
