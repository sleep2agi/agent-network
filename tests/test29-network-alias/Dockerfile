FROM oven/bun:1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates nodejs npm && \
    rm -rf /var/lib/apt/lists/*

COPY server/package*.json server/
RUN cd server && bun install

COPY server/ server/
COPY tests/test29-network-alias/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["bash", "/app/run.sh"]
