ARG SOURCE_COMMIT
FROM node:22-bookworm-slim
# Board #556 — agent-node's codex-health / app-server relaunch probes against real
# tmux 3.3a on a PRIVATE socket, LANG=C, CJK session name. The modules under test
# import only node: built-ins, so no npm install: bun + tmux + agent-node/src.
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl tmux unzip \
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
COPY agent-node/package.json ./agent-node/package.json
COPY agent-node/src ./agent-node/src
COPY tests/test556-node-tmux-format-locale ./tests/test556-node-tmux-format-locale

ARG SOURCE_COMMIT
ENV TEST556_SOURCE_COMMIT=$SOURCE_COMMIT
RUN chown -R node:node /workspace
USER node

ENTRYPOINT ["bash", "tests/test556-node-tmux-format-locale/run.sh"]
