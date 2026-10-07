FROM oven/bun:1.3.14
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
WORKDIR /repo
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ >/dev/null && rm -rf /var/lib/apt/lists/*
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && bun install --frozen-lockfile
COPY agent-network ./agent-network
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
RUN cd agent-node && bun install --frozen-lockfile
COPY agent-node ./agent-node
COPY tests/test1178-codex-upgrade-recovery/run.sh ./run.sh
COPY tests/test1178-codex-upgrade-recovery/mutation.mjs ./mutation.mjs
RUN chmod +x ./run.sh
CMD ["./run.sh"]
