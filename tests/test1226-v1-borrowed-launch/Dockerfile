FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends procps python3 tmux ca-certificates && rm -rf /var/lib/apt/lists/*
RUN install -d -m 0755 /run/user && install -d -m 0700 -o node -g node /run/user/1000
ARG OPENCODE_VERSION
COPY tests/test1194-v1-shared-feasibility/package-integrity.json /fixture/package-integrity.json
RUN npm view "opencode-ai@${OPENCODE_VERSION}" dist.integrity > /tmp/wrapper-sri && npm view "opencode-linux-x64@${OPENCODE_VERSION}" dist.integrity > /tmp/native-sri
RUN OPENCODE_VERSION=${OPENCODE_VERSION} node -e 'const f=require("fs"),v=process.env.OPENCODE_VERSION,d=require("/fixture/package-integrity.json")[v];for(const [p,n] of [["opencode-ai","wrapper"],["opencode-linux-x64","native"]])if(f.readFileSync(`/tmp/${n}-sri`,"utf8").trim()!==d[p].integrity)throw Error("package integrity changed")'
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" --no-audit --no-fund && test "$(opencode --version)" = "${OPENCODE_VERSION}"
WORKDIR /repo/agent-node
COPY agent-node/package.json agent-node/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY agent-node/src ./src
COPY agent-network/src /repo/agent-network/src
COPY agent-network/package.json agent-network/package-lock.json /repo/agent-network/
RUN cd /repo/agent-network && npm ci --ignore-scripts --no-audit --no-fund
COPY agent-network/bin /repo/agent-network/bin
RUN cd /repo/agent-network && bun build bin/cli.ts --outdir dist/bin --target node --external @sleep2agi/commhub-server --external bun:sqlite --external '../../server/*' 
RUN npm run build
RUN mkdir -p /opt/node_modules/@sleep2agi && cp -a /repo/agent-node /opt/node_modules/@sleep2agi/agent-node
COPY deploy/node/opencode-v1-host /repo/deploy/node/opencode-v1-host
COPY tests/test1226-v1-borrowed-launch /fixture
COPY tests/test651-opencode-timeout-abort/run.sh /fixture/timeout-mutation.sh
RUN chmod 0755 /fixture/anet
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT OPENCODE_VERSION_UNDER_TEST=$OPENCODE_VERSION
USER node
CMD ["bash", "/fixture/run.sh"]
