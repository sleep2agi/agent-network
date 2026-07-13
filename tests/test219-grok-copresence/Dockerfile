ARG SOURCE_COMMIT=uncommitted
FROM node:22-bookworm-slim
ARG SOURCE_COMMIT
ENV TEST219_SOURCE_COMMIT=$SOURCE_COMMIT

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl git python3 unzip util-linux \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/

RUN cd agent-node && npm install --include=optional \
  && cd ../agent-network && npm ci

COPY . /workspace
RUN rm -rf /workspace/.git

ENTRYPOINT ["bash", "tests/test219-grok-copresence/run.sh"]
