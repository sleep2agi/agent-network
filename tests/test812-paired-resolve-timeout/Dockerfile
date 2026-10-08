FROM node:22.23.0-bookworm@sha256:e0d149b4727ac0c20d9774e801e423d7a946a0bffced886f42cfe9cd3c67820a
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && npm ci --ignore-scripts --no-audit --no-fund
COPY agent-network ./agent-network
COPY agent-node/package.json ./agent-node/package.json
COPY tests/test812-paired-resolve-timeout ./tests/test812-paired-resolve-timeout
CMD ["bash", "tests/test812-paired-resolve-timeout/run.sh"]
