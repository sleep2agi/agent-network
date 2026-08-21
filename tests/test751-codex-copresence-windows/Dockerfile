FROM oven/bun:1.3.14
WORKDIR /workspace
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && bun install --frozen-lockfile --ignore-scripts
COPY agent-network ./agent-network
COPY tests/test751-codex-copresence-windows/run.sh /run.sh
ENTRYPOINT ["bash", "/run.sh"]
