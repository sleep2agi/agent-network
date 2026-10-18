FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm python3 ca-certificates && rm -rf /var/lib/apt/lists/*
RUN install -d -m 0755 /run/user && install -d -m 0700 -o bun -g bun /run/user/1000
ARG OPENCODE_VERSION
COPY tests/test1194-v1-shared-feasibility/package-integrity.json /fixture/package-integrity.json
RUN npm view "opencode-ai@${OPENCODE_VERSION}" dist.integrity > /tmp/wrapper-sri && npm view "opencode-linux-x64@${OPENCODE_VERSION}" dist.integrity > /tmp/native-sri
RUN OPENCODE_VERSION=${OPENCODE_VERSION} node -e 'const f=require("fs"),v=process.env.OPENCODE_VERSION,d=require("/fixture/package-integrity.json")[v];for(const [p,n] of [["opencode-ai","wrapper"],["opencode-linux-x64","native"]])if(f.readFileSync(`/tmp/${n}-sri`,"utf8").trim()!==d[p].integrity)throw Error("package integrity changed")'
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" --no-audit --no-fund && test "$(opencode --version)" = "${OPENCODE_VERSION}"
WORKDIR /repo/agent-node
COPY agent-node/package.json agent-node/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY agent-node/src /repo/agent-node/src
COPY tests/test1246-v1-safe-topology /fixture
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT OPENCODE_VERSION_UNDER_TEST=$OPENCODE_VERSION
USER bun
CMD ["bash", "/fixture/run.sh"]
