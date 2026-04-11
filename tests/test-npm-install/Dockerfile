FROM oven/bun:1

WORKDIR /app

RUN apt-get update && apt-get install -y curl python3 nodejs npm && rm -rf /var/lib/apt/lists/*
RUN npm i -g @sleep2agi/commhub-server@preview @sleep2agi/agent-node@preview
COPY agent-network/ /app/agent-network/
RUN cd /app/agent-network && bun install

COPY tests/test-npm-install/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["bash", "/app/run.sh"]
