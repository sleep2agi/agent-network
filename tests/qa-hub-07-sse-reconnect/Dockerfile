FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates jq unzip && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
COPY tests/qa-hub-07-sse-reconnect/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
