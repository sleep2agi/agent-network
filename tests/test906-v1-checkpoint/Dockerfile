# TEST-ONLY: real pinned V1 binaries, synthetic local model, no Hub/accounts.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS base
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm python3 procps ca-certificates && rm -rf /var/lib/apt/lists/*
RUN install -d -m 0755 /run/user && install -d -m 0700 -o bun -g bun /run/user/1000
WORKDIR /repo/agent-node
COPY agent-node/package.json agent-node/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY agent-node/ ./
COPY deploy/node/ /repo/deploy/node/
COPY tests/test543-opencode-v2-copresence/stub-model.py /fixture/stub-model.py
COPY tests/test906-v1-checkpoint/ /fixture-checkpoint/
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

FROM base AS v11834
RUN npm install -g opencode-ai@1.18.34 --no-audit --no-fund && test "$(opencode --version)" = 1.18.34
ENV OPENCODE_VERSION_UNDER_TEST=1.18.34
USER bun
CMD ["bash", "/fixture-checkpoint/run.sh"]

FROM base AS v1181
RUN npm install -g opencode-ai@1.18.1 --no-audit --no-fund && test "$(opencode --version)" = 1.18.1
ENV OPENCODE_VERSION_UNDER_TEST=1.18.1
USER bun
CMD ["bash", "/fixture-checkpoint/run.sh"]
