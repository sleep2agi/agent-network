FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates unzip python3 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
WORKDIR /app
ARG TEST681_SOURCE_COMMIT=red
ENV TEST681_SOURCE_COMMIT=${TEST681_SOURCE_COMMIT}
COPY agent-node /app/agent-node
RUN cd /app/agent-node && bun install --silent
COPY tests/test681-explicit-lifecycle /app/tests/test681-explicit-lifecycle
CMD ["/app/tests/test681-explicit-lifecycle/run.sh"]
