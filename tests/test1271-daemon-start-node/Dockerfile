ARG SOURCE_COMMIT
FROM node:22-bookworm-slim
ARG BUN_VERSION=1.3.14
ARG BUN_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
RUN apt-get update && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl python3 unzip util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
 && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c --strict \
 && unzip -j /tmp/bun.zip 'bun-linux-x64/bun' -d /usr/local/bin && chmod 0755 /usr/local/bin/bun
WORKDIR /workspace
COPY server/package*.json server/
COPY agent-node/package*.json agent-node/
RUN cd server && npm ci && cd ../agent-node && npm ci
COPY server server
COPY agent-node agent-node
COPY contracts contracts
COPY tests/test1271-daemon-start-node tests/test1271-daemon-start-node
ARG SOURCE_COMMIT
ENV TEST1271_SOURCE_COMMIT=$SOURCE_COMMIT COMMHUB_DB=/tmp/test1271.db
RUN chmod 0755 tests/test1271-daemon-start-node/run.sh
ENTRYPOINT ["bash","tests/test1271-daemon-start-node/run.sh"]
