FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates unzip python3 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
WORKDIR /app
ARG TEST682_SOURCE_COMMIT=red
ENV TEST682_SOURCE_COMMIT=${TEST682_SOURCE_COMMIT}
COPY agent-node/package.json /app/agent-node/package.json
COPY agent-network/package.json /app/agent-network/package.json
COPY server/package.json /app/server/package.json
RUN cd /app/agent-node && bun install --silent
RUN cd /app/agent-network && bun install --silent --ignore-scripts
RUN cd /app/server && bun install --silent
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network
COPY server /app/server
COPY tests/test682-uncovered-task-trace /app/tests/test682-uncovered-task-trace
CMD ["/app/tests/test682-uncovered-task-trace/run.sh"]
