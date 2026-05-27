FROM oven/bun:1.3.1

WORKDIR /repo
COPY agent-node/package.json agent-node/package.json
COPY agent-node/src agent-node/src
COPY tests/test199-agent-node-from-session/run.sh tests/run-agent-node-from-session.sh

WORKDIR /repo/agent-node
RUN bun install

CMD ["bash", "/repo/tests/run-agent-node-from-session.sh"]
