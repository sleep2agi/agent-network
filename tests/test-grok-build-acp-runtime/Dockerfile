FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git jq procps python3 unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:/root/.local/bin:/root/.grok/bin:/usr/local/bin:/usr/bin:/bin"

WORKDIR /workspace
COPY . /workspace

RUN cd server && bun install \
  && cd ../agent-node && bun install

ENTRYPOINT ["bash", "tests/test-grok-build-acp-runtime/run.sh"]
