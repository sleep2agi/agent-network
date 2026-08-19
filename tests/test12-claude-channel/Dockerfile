FROM oven/bun:1
WORKDIR /app
RUN apt-get update && apt-get install -y curl python3 && rm -rf /var/lib/apt/lists/*
COPY server/ server/
RUN cd server && bun install
COPY tests/test12-claude-channel/run.sh /app/run.sh
RUN chmod +x /app/run.sh
ENV COMMHUB_AUTH_TOKEN=test-auth-token
ARG TEST12_SOURCE_COMMIT=dev
ENV TEST12_SOURCE_COMMIT=$TEST12_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST12_SOURCE_COMMIT

CMD ["bash", "/app/run.sh"]
