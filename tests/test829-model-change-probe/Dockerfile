ARG DEPENDENCY_IMAGE=anet-test539:release-f4bf
ARG CLIENT_IMAGE=anet-model-ui:deadline-4500
FROM ${CLIENT_IMAGE} AS client
FROM ${DEPENDENCY_IMAGE}
USER root
COPY --from=client /web-model /client-web
COPY --from=client /app/tests/test-layout-sweep/harness.mjs /client-plumbing/harness.mjs
COPY tests/test829-model-change-probe/harness.ts /workspace/tests/test829-opencode-create/native-harness.ts
COPY tests/test829-model-change-probe/model-client.mjs /workspace/tests/test829-opencode-create/model-client.mjs
COPY tests/test543-opencode-v2-copresence/stub-model.py /test827/stub-model.py
ARG PROBE_COMMIT
ENV PROBE_COMMIT=$PROBE_COMMIT
ENV CLIENT_SOURCE_COMMIT=4500c233e38fbdc2db5932f5edbe92f4fdd1ab9c \
    TEST829_MODEL_DRIVER=/workspace/tests/test829-opencode-create/model-client.mjs \
    ANET_TMUX_SOCKET=/home/test829-native/tmux.sock
USER node
ENTRYPOINT ["bash", "/workspace/tests/test829-opencode-create/native-nonroot.sh"]
