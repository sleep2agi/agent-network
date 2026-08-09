FROM oven/bun:1.3.14

WORKDIR /repo
COPY agent-node/package.json /repo/agent-node/package.json
RUN cd /repo/agent-node && bun install
COPY agent-node /repo/agent-node
COPY tests/test657-claude-native-version-pin /repo/tests/test657-claude-native-version-pin
RUN chmod +x /repo/tests/test657-claude-native-version-pin/run.sh

ARG TEST657_SOURCE_COMMIT=unknown
ENV TEST657_SOURCE_COMMIT=$TEST657_SOURCE_COMMIT

CMD ["bash", "/repo/tests/test657-claude-native-version-pin/run.sh"]
