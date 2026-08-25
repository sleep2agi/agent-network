FROM oven/bun:1.3.14
WORKDIR /repo
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ >/dev/null && rm -rf /var/lib/apt/lists/*
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && bun install --frozen-lockfile
COPY agent-network ./agent-network
COPY tests/test1178-codex-upgrade-recovery/run.sh ./run.sh
RUN chmod +x ./run.sh
CMD ["./run.sh"]
