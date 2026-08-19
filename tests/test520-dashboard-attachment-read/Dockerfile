FROM oven/bun:1.3.14

WORKDIR /workspace
COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY agent-network ./agent-network
COPY agent-node ./agent-node
COPY tests/test520-dashboard-attachment-read ./tests/test520-dashboard-attachment-read

ARG TEST520_ATTACHMENT_SOURCE_COMMIT=uncommitted
ENV TEST520_ATTACHMENT_SOURCE_COMMIT=$TEST520_ATTACHMENT_SOURCE_COMMIT
RUN chmod 0755 tests/test520-dashboard-attachment-read/run.sh

# SHA 绑定（#1092）。scripts/qa.sh 从这里 grep `^ARG SOURCE_COMMIT` 决定传不传
# --build-arg；没有这一行就**不传，而且不报错**，本次运行无法被钉到任何提交上。
# 放在 ENTRYPOINT 之前而不是文件开头 —— 否则每次 commit 都会让上面的 COPY 层失效。
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT

ENTRYPOINT ["/workspace/tests/test520-dashboard-attachment-read/run.sh"]
