FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates unzip python3 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
WORKDIR /app
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network
COPY server /app/server
RUN cd /app/agent-node && bun install --silent
RUN cd /app/agent-network && bun install --silent --ignore-scripts
RUN cd /app/server && bun install --silent
ARG TEST679_SOURCE_COMMIT=unknown
ENV TEST679_SOURCE_COMMIT=${TEST679_SOURCE_COMMIT}
COPY tests/test679-task-trace /app/tests/test679-task-trace
CMD ["/app/tests/test679-task-trace/run.sh"]
