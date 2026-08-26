FROM oven/bun:1

WORKDIR /app
RUN apt-get update && apt-get install -y curl python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY agent-network/ agent-network/
RUN cd agent-network && bun install

COPY tests/test226-skillhub-cli/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["bash", "/app/run.sh"]
