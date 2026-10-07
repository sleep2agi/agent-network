FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
RUN apt-get update && apt-get install -y --no-install-recommends postgresql && rm -rf /var/lib/apt/lists/*
WORKDIR /work/server
COPY server/package.json server/package-lock.json ./
RUN bun install --frozen-lockfile
COPY server/src ./src
COPY server/bin ./bin
COPY agent-network/src /work/agent-network/src
COPY agent-network/bin /work/agent-network/bin
COPY agent-node/src /work/agent-node/src
COPY tests/test678-daemon-token-owner /work/tests/test678-daemon-token-owner
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
CMD ["bash", "/work/tests/test678-daemon-token-owner/run.sh"]
