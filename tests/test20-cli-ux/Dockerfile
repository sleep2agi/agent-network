FROM oven/bun:1
WORKDIR /app
RUN apt-get update && apt-get install -y curl python3 && rm -rf /var/lib/apt/lists/*
COPY server/ server/
COPY agent-network/ agent-network/
RUN cd server && bun install
RUN cd agent-network && bun install
COPY tests/test20-cli-ux/run.sh /app/run.sh
RUN chmod +x /app/run.sh
ENV COMMHUB_AUTH_TOKEN=test-auth-token
CMD ["bash", "/app/run.sh"]
