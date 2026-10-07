FROM node:22-bookworm-slim
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
WORKDIR /repo
RUN apt-get update -qq && apt-get install -y --no-install-recommends curl ca-certificates unzip python3 make g++ >/dev/null && rm -rf /var/lib/apt/lists/*
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
RUN printf '%s\n' "$BUN_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
 || { echo "ERROR: BUN_VERSION must be x.y.z, got: $BUN_VERSION" >&2; exit 2; }
RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
 && echo "${BUN_LINUX_X64_SHA256}  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/bun.zip -d /tmp/bunx \
 && mv /tmp/bunx/bun-linux-x64/bun /usr/local/bin/bun \
 && rm -rf /tmp/bun.zip /tmp/bunx
RUN npm install -g --no-audit --no-fund @openai/codex@0.133.0
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && bun install --frozen-lockfile
COPY agent-network ./agent-network
RUN cd agent-network && bun build src/codex-copresence-rpc.ts --target node --format esm --outfile /repo/agent-network/.test-codex-copresence-rpc.mjs
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
RUN cd agent-node && bun install --frozen-lockfile
COPY agent-node ./agent-node
COPY tests/test1178-codex-upgrade-recovery/run.sh ./run.sh
COPY tests/test1178-codex-upgrade-recovery/mutation.mjs ./mutation.mjs
COPY tests/test1178-codex-upgrade-recovery/node-payload-mutation.mjs ./node-payload-mutation.mjs
COPY tests/test1178-codex-upgrade-recovery/real-0133-large-resume.mjs ./real-0133-large-resume.mjs
RUN chmod +x ./run.sh
CMD ["./run.sh"]
