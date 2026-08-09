FROM oven/bun:1.3.14

WORKDIR /workspace
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && bun install --ignore-scripts
COPY agent-network ./agent-network
COPY tests/test623-feishu-scrub-health ./tests/test623-feishu-scrub-health

ARG SOURCE_COMMIT
ENV TEST623_SOURCE_COMMIT=$SOURCE_COMMIT
RUN chmod 0755 /workspace/tests/test623-feishu-scrub-health/run.sh
ENTRYPOINT ["/workspace/tests/test623-feishu-scrub-health/run.sh"]
