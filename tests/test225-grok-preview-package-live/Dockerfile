ARG SOURCE_COMMIT

FROM node:22-bookworm-slim AS packer

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl git python3 unzip \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"

WORKDIR /build
COPY agent-node/package.json ./agent-node/package.json
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-node && bun install \
  && cd ../agent-network && bun install --ignore-scripts

COPY agent-node ./agent-node
COPY agent-network ./agent-network

RUN mkdir -p /candidate \
  && cd /build/agent-node \
  && npm run build \
  && npm pack --ignore-scripts --pack-destination /candidate \
  && cd /build/agent-network \
  && npm run build \
  && npm pack --ignore-scripts --pack-destination /candidate


FROM node:22-bookworm-slim AS runtime

ARG SOURCE_COMMIT
ENV TEST225_SOURCE_COMMIT=$SOURCE_COMMIT

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash bubblewrap build-essential ca-certificates curl git jq procps python3 tmux unzip util-linux \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"

COPY --from=packer /candidate /candidate
RUN npm install -g /candidate/sleep2agi-agent-network-*.tgz \
  && npm install -g @sleep2agi/commhub-server@0.9.0-preview.21 \
  && npm cache clean --force \
  && anet --help | grep -Fq grok-build-cli \
  && commhub-server --help >/dev/null

COPY tests/test225-grok-preview-package-live /test225
RUN chmod 755 /test225/run.sh /test225/fake-grok.mjs /test225/local-registry.mjs /test225/npx-env-wrapper.mjs

WORKDIR /test225-work
ENTRYPOINT ["bash", "/test225/run.sh"]
