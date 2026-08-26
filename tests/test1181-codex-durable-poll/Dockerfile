FROM oven/bun:1.3.14

ARG TEST1181_SOURCE_COMMIT=dev
ENV TEST1181_SOURCE_COMMIT=$TEST1181_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST1181_SOURCE_COMMIT

WORKDIR /workspace
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
RUN cd agent-node && bun install --frozen-lockfile
COPY agent-node ./agent-node
COPY tests/test1181-codex-durable-poll/run.sh ./run.sh
COPY tests/test1181-codex-durable-poll/witnessed-red.sh ./witnessed-red.sh
RUN chmod +x ./run.sh ./witnessed-red.sh

CMD ["./run.sh"]
