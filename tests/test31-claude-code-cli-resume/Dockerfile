FROM oven/bun:1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends bash nodejs npm ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY agent-network/ agent-network/
COPY tests/test31-claude-code-cli-resume/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["bash", "/app/run.sh"]
