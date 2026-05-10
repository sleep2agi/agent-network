FROM oven/bun:1
WORKDIR /app
RUN apt-get update && apt-get install -y curl python3 nodejs npm && rm -rf /var/lib/apt/lists/*
COPY tests/test-npm-api/run.sh /app/run.sh
RUN chmod +x /app/run.sh
CMD ["bash", "/app/run.sh"]
