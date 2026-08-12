ARG SOURCE_COMMIT
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates cron curl python3 unzip util-linux \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash \
  && install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-node && npm install --include=optional \
  && cd ../agent-network && npm ci

ARG SOURCE_COMMIT
ENV TEST725_SOURCE_COMMIT=$SOURCE_COMMIT

COPY agent-node ./agent-node
COPY agent-network ./agent-network
COPY tests/test725-agent-node-unit-ci/run.sh ./tests/test725-agent-node-unit-ci/run.sh
RUN chmod 0755 ./tests/test725-agent-node-unit-ci/run.sh \
  && install -d -o node -g node -m 0700 "/run/user/$(id -u node)" \
  && chown -R node:node /workspace

ENTRYPOINT ["bash", "tests/test725-agent-node-unit-ci/run.sh"]
