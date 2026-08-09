FROM oven/bun:1.3.14

WORKDIR /repo
ARG TEST661_SOURCE_COMMIT=unknown
ENV TEST661_SOURCE_COMMIT=$TEST661_SOURCE_COMMIT

COPY agent-network/package.json /repo/agent-network/package.json
COPY agent-node/package.json /repo/agent-node/package.json
# This suite imports the Feishu bridge + a pure agent-node helper only. Avoid
# running node-pty's unrelated native postinstall (which would add Python/gyp
# to the image without exercising any code in scope).
RUN cd /repo/agent-network && bun install --ignore-scripts \
 && cd /repo/agent-node && bun install --ignore-scripts

COPY agent-network /repo/agent-network
COPY agent-node /repo/agent-node
COPY tests/test661-feishu-bridge-wire /repo/tests/test661-feishu-bridge-wire
RUN chmod +x /repo/tests/test661-feishu-bridge-wire/run.sh

CMD ["bash", "/repo/tests/test661-feishu-bridge-wire/run.sh"]
