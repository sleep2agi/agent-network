FROM oven/bun:1.3.14
RUN apt-get update && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY server/package.json server/package-lock.json ./server/
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
RUN cd server && bun install --frozen-lockfile --ignore-scripts \
 && cd ../agent-node && bun install --frozen-lockfile --ignore-scripts
COPY server/src ./server/src
COPY agent-node/src ./agent-node/src
COPY tests/test819-codex-start-completion/run.sh ./run.sh
CMD ["bash", "/work/run.sh"]
