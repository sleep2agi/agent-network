FROM oven/bun:1.3.14

WORKDIR /workspace

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY docker/feishu ./docker/feishu
COPY docs-site/docs/guide/feishu.md ./docs-site/docs/guide/feishu.md
COPY docs-site/docs/en/guide/feishu.md ./docs-site/docs/en/guide/feishu.md
COPY tests/lib ./tests/lib
COPY tests/test616-feishu-docker-bootstrap ./tests/test616-feishu-docker-bootstrap

ARG SOURCE_COMMIT
ENV TEST616_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test616-feishu-docker-bootstrap/run.sh
ENTRYPOINT ["/workspace/tests/test616-feishu-docker-bootstrap/run.sh"]
