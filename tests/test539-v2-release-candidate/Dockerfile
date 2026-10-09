# Local candidate gate, not a publishable artifact or clean dependency install.
# Record the resolved dependency image digest in the report.
ARG DEPENDENCY_IMAGE=anet-test829:client-deadline-2d3
FROM ${DEPENDENCY_IMAGE}
USER root
COPY agent-network /workspace/agent-network
COPY agent-node /opt/node_modules/@sleep2agi/agent-node
COPY server /workspace/server
COPY scripts /workspace/scripts
COPY docs /workspace/docs
COPY docs-site /workspace/docs-site
COPY tests/test661-explicit-bootstrap-db /workspace/tests/test661-explicit-bootstrap-db
COPY tests/test539-v2-release-candidate /workspace/tests/test539-v2-release-candidate
RUN test -e /workspace/agent-node || ln -s /opt/node_modules/@sleep2agi/agent-node /workspace/agent-node
WORKDIR /workspace
RUN git init -q && chmod 644 /opt/node_modules/@sleep2agi/agent-node/package.json
RUN bun test agent-network/src/package-version-consistency.test.ts \
    agent-network/src/opencode-agent-node-pair.test.ts \
    agent-network/src/hub-server-version.test.ts \
    agent-node/src/package-version-consistency.test.ts \
    server/src/package-version-consistency.test.ts
RUN cd agent-node && bun run build
RUN cd agent-network && npm run build
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["bash", "/workspace/tests/test539-v2-release-candidate/run.sh"]
