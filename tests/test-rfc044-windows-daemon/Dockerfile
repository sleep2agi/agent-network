FROM oven/bun:1.3.14
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY agent-node ./agent-node
COPY agent-network ./agent-network
RUN cd agent-network && bun install --frozen-lockfile --ignore-scripts
COPY contracts ./contracts
COPY server/src/contracts ./server/src/contracts
COPY tests/test-rfc044-windows-daemon ./tests/test-rfc044-windows-daemon
CMD ["bash", "tests/test-rfc044-windows-daemon/run.sh"]
