FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq procps sqlite3 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
ARG TEST185_SOURCE_COMMIT=unknown
ENV TEST185_SOURCE_COMMIT=${TEST185_SOURCE_COMMIT}

COPY server /app/server
COPY agent-node /app/agent-node
COPY tests/lib /app/tests/lib
COPY tests/test185-external-schedules /app/tests/test185-external-schedules
RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent
RUN chmod +x /app/tests/test185-external-schedules/run.sh

CMD ["/app/tests/test185-external-schedules/run.sh"]
