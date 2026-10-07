FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
WORKDIR /repo
RUN apt-get update -qq && apt-get install -y --no-install-recommends coreutils bash python3 make g++ >/dev/null && rm -rf /var/lib/apt/lists/*
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
RUN cd agent-node && bun install --frozen-lockfile
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && bun install --frozen-lockfile
COPY agent-node ./agent-node
COPY agent-network ./agent-network
COPY tests/test705-bridge-epipe/run.sh ./run.sh
COPY tests/test705-bridge-epipe/mutation.mjs ./mutation.mjs
RUN chmod 0755 ./run.sh
ENTRYPOINT ["./run.sh"]
