FROM oven/bun:1
WORKDIR /app
RUN apt-get update && apt-get install -y curl python3 && rm -rf /var/lib/apt/lists/*
COPY server/ server/
RUN cd server && bun install
COPY agent-network/package.json agent-network/package-lock.json agent-network/
COPY agent-network/dist/ agent-network/dist/
COPY agent-node/package.json agent-node/
COPY agent-node/dist/ agent-node/dist/
RUN printf '%s\n' '#!/bin/sh' 'exec bun /app/agent-network/dist/bin/cli.js "$@"' > /usr/local/bin/anet \
 && printf '%s\n' '#!/bin/sh' 'exec bun /app/agent-node/dist/cli.js "$@"' > /usr/local/bin/agent-node \
 && chmod +x /usr/local/bin/anet /usr/local/bin/agent-node
COPY tests/test7-config/run.sh /app/run.sh
RUN chmod +x /app/run.sh
ENV COMMHUB_AUTH_TOKEN=test-auth-token
CMD ["bash", "/app/run.sh"]
