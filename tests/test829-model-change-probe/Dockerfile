ARG DEPENDENCY_IMAGE=anet-test539:release-f4bf
FROM ${DEPENDENCY_IMAGE}
USER root
COPY tests/test829-model-change-probe/harness.ts /workspace/tests/test829-opencode-create/native-harness.ts
ARG PROBE_COMMIT
ENV PROBE_COMMIT=$PROBE_COMMIT
USER node
ENTRYPOINT ["bash", "/workspace/tests/test829-opencode-create/native-nonroot.sh"]
