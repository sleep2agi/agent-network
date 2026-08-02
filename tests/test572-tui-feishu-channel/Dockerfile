FROM oven/bun:1

WORKDIR /work
COPY agent-node ./agent-node
COPY agent-network ./agent-network
COPY tests/test572-tui-feishu-channel/run.sh ./tests/test572-tui-feishu-channel/run.sh
COPY tests/test572-tui-feishu-channel/mutate.mjs ./tests/test572-tui-feishu-channel/mutate.mjs
COPY tests/test572-tui-feishu-channel/run-mutation.sh ./tests/test572-tui-feishu-channel/run-mutation.sh

ENTRYPOINT ["bash", "tests/test572-tui-feishu-channel/run.sh"]
