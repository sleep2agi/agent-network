FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*
WORKDIR /repo/agent-node
COPY agent-node/package.json agent-node/package-lock.json ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY agent-node/src ./src
COPY tests/test1155-followup-receipts/run.sh /fixture/run.sh
ARG SOURCE_COMMIT=local
ENV SOURCE_COMMIT=$SOURCE_COMMIT
CMD ["bash", "/fixture/run.sh"]
