FROM oven/bun:1.3.14
WORKDIR /app
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
COPY server/package.json server/package-lock.json ./server/
RUN cd agent-network && bun install --frozen-lockfile --ignore-scripts
RUN cd agent-node && bun install --frozen-lockfile --ignore-scripts
RUN cd server && bun install --frozen-lockfile --ignore-scripts
COPY agent-network ./agent-network
COPY agent-node ./agent-node
COPY server ./server
COPY contracts ./contracts
COPY tests/test4916-rules-file-delivery ./tests/test4916-rules-file-delivery
CMD ["bash", "tests/test4916-rules-file-delivery/run.sh"]
