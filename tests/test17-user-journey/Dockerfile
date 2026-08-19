FROM oven/bun:1
WORKDIR /app
RUN apt-get update && apt-get install -y curl python3 nodejs npm && rm -rf /var/lib/apt/lists/*
RUN npm i -g @sleep2agi/commhub-server@preview @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
COPY tests/test17-user-journey/run.sh /app/run.sh
RUN chmod +x /app/run.sh
ARG TEST17_SOURCE_COMMIT=dev
ENV TEST17_SOURCE_COMMIT=$TEST17_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST17_SOURCE_COMMIT

CMD ["bash", "/app/run.sh"]
