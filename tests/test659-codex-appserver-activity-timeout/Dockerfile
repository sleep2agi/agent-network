FROM oven/bun:1.3.14

WORKDIR /repo
COPY agent-node/package.json /repo/agent-node/package.json
RUN cd /repo/agent-node && bun install
COPY agent-node /repo/agent-node
COPY tests/test659-codex-appserver-activity-timeout /repo/tests/test659-codex-appserver-activity-timeout
RUN chmod +x /repo/tests/test659-codex-appserver-activity-timeout/run.sh

ARG TEST659_SOURCE_COMMIT=unknown
ENV TEST659_SOURCE_COMMIT=$TEST659_SOURCE_COMMIT

CMD ["bash", "/repo/tests/test659-codex-appserver-activity-timeout/run.sh"]
