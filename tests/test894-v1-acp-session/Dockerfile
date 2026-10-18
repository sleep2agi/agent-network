# Build RUNTIME_IMAGE with tests/test894-v1-runtime/Dockerfile first.
# It supplies pinned Bun/OpenCode and lockfile-installed runtime dependencies.
ARG RUNTIME_IMAGE
FROM ${RUNTIME_IMAGE}
USER root
COPY agent-node/package-lock.json /tmp/current-agent-node-lock.json
RUN cmp /tmp/current-agent-node-lock.json /agent-node-src/package-lock.json
COPY agent-node/src/ /agent-node-src/src/
COPY tests/test894-v1-acp-session/ /fixture-acp/
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
USER bun
CMD ["bash", "/fixture-acp/run.sh"]
