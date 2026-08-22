FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY agent-node ./agent-node
COPY tests/test760-native-goal-passthrough ./tests/test760-native-goal-passthrough
RUN chmod 0755 /workspace/tests/test760-native-goal-passthrough/run.sh
ENTRYPOINT ["/workspace/tests/test760-native-goal-passthrough/run.sh"]
