ARG SOURCE_COMMIT

FROM node:22-bookworm-slim AS packer

ARG SOURCE_COMMIT

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl git python3 unzip \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash \
  && install -m 755 /root/.bun/bin/bun /usr/local/bin/bun \
  && rm -rf /root/.bun
ENV PATH="/usr/local/bin:/usr/bin:/bin"

WORKDIR /build
COPY agent-node/package.json ./agent-node/package.json
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-node && bun install \
  && cd ../agent-network && bun install --ignore-scripts

COPY agent-node ./agent-node
COPY agent-network ./agent-network
COPY tests/test225-grok-preview-package-live ./tests/test225-grok-preview-package-live

RUN node --test ./tests/test225-grok-preview-package-live/artifact-report.test.mjs

# Prove the three source boundaries agree before the source tree is discarded.
RUN TEST225_FAILURE_CONTRACT_MODE=source \
  TEST225_SOURCE_COMMIT="$SOURCE_COMMIT" \
  node --test \
    ./tests/test225-grok-preview-package-live/auth-evidence-diagnostic.test.mjs \
    ./tests/test225-grok-preview-package-live/auth-evidence-gate-policy.test.mjs \
    ./tests/test225-grok-preview-package-live/failure-diagnostic.test.mjs \
    ./tests/test225-grok-preview-package-live/inventory-gate.test.mjs \
    ./tests/test225-grok-preview-package-live/inventory-diagnostic.test.mjs

RUN mkdir -p /candidate \
  && cd /build/agent-node \
  && npm run build \
  && npm pack --ignore-scripts --pack-destination /candidate \
  && cd /build/agent-network \
  && npm run build \
  && npm pack --ignore-scripts --pack-destination /candidate \
  && set -- /candidate/sleep2agi-agent-node-*.tgz \
  && [ "$#" -eq 1 ] \
  && [ -f "$1" ] \
  && tar -xOf "$1" package/dist/cli.js > /tmp/test225-agent-node-cli.js \
  && TEST225_AGENT_NODE_BUNDLE=/tmp/test225-agent-node-cli.js \
    node --test /build/tests/test225-grok-preview-package-live/failure-contract-bundle.test.mjs \
  && node /build/tests/test225-grok-preview-package-live/failure-contract.mjs \
    /build/agent-node/src/runtime/grok-copresence/runtime.ts \
    /build/agent-node/src/cli.ts \
    "$SOURCE_COMMIT" \
    "$1" \
    /tmp/test225-agent-node-cli.js \
    /candidate/test225-grok-failure-contract.v1.json \
  && rm -f /tmp/test225-agent-node-cli.js


FROM node:22-bookworm-slim AS runtime

ARG SOURCE_COMMIT
ENV TEST225_SOURCE_COMMIT=$SOURCE_COMMIT

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash bubblewrap build-essential ca-certificates curl git jq procps python3 tmux unzip util-linux \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash \
  && install -m 755 /root/.bun/bin/bun /usr/local/bin/bun \
  && rm -rf /root/.bun
ENV PATH="/usr/local/bin:/usr/bin:/bin"

COPY --from=packer /candidate /candidate
RUN npm install -g /candidate/sleep2agi-agent-network-*.tgz \
  && npm install -g @sleep2agi/commhub-server@0.9.0-preview.21 \
  && npm cache clean --force \
  && anet --help | grep -Fq grok-build-cli \
  && commhub-server --help >/dev/null

COPY tests/test225-grok-preview-package-live /test225
COPY tests/lib/safe-rm.sh /test225/lib/safe-rm.sh
RUN chmod 755 /test225/run.sh /test225/fake-grok.mjs /test225/local-registry.mjs /test225/npx-env-wrapper.mjs /test225/old-v1-agent-node.mjs /test225/tui-tool-inventory-probe.mjs

RUN mkdir -p /test225-work && chown node:node /test225-work
USER node
WORKDIR /test225-work
ENTRYPOINT ["bash", "/test225/run.sh"]
