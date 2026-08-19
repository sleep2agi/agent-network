FROM oven/bun:1
WORKDIR /app
RUN apt-get update && apt-get install -y curl python3 && rm -rf /var/lib/apt/lists/*
COPY server/ server/
RUN cd server && bun install
COPY agent-network/ agent-network/
RUN cd agent-network && bun install
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
COPY tests/test21-quickstart-ux/run.sh /app/run.sh
RUN chmod +x /app/run.sh
ENV COMMHUB_AUTH_TOKEN=test-auth-token
CMD ["bash", "/app/run.sh"]
