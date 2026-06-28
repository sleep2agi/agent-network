FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates jq unzip procps && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
COPY tests/qa-cli-02-network-create/run.sh /app/run.sh
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
