FROM oven/bun:1.3.14
RUN apt-get update \
 && apt-get install -y --no-install-recommends cron \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY agent-node ./agent-node
COPY agent-network ./agent-network
COPY server/src/shared/external-schedule-contract.ts ./server/src/shared/external-schedule-contract.ts
COPY tests/test689-owner-schedule-agent ./tests/test689-owner-schedule-agent
ARG SOURCE_COMMIT
ENV TEST689_SOURCE_COMMIT=$SOURCE_COMMIT
RUN chmod 0755 /workspace/tests/test689-owner-schedule-agent/run.sh
ENTRYPOINT ["/workspace/tests/test689-owner-schedule-agent/run.sh"]
