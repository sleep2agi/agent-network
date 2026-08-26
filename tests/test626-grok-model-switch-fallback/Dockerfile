FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl git python3 unzip util-linux \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"

WORKDIR /workspace
COPY agent-node/package.json agent-node/bun.lock ./agent-node/

RUN cd agent-node && bun install

COPY . /workspace

ENTRYPOINT ["bash", "tests/test626-grok-model-switch-fallback/run.sh"]
