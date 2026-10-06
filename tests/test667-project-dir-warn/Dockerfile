FROM oven/bun:1.3.1

WORKDIR /src
COPY agent-node/src/project-dir-mismatch.ts /src/project-dir-mismatch.ts
COPY agent-node/src/cli.ts /src/cli.ts
COPY agent-network/src/codex-external-appserver.ts /anet/codex-external-appserver.ts
COPY agent-network/bin/cli.ts /anet/cli.ts
COPY tests/test667-project-dir-warn/probe.mjs /test667/probe.mjs
COPY tests/test667-project-dir-warn/run.sh /test667/run.sh
RUN chmod +x /test667/run.sh

ARG TEST667_SOURCE_COMMIT=dev
ENV TEST667_SOURCE_COMMIT=$TEST667_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST667_SOURCE_COMMIT

CMD ["bash", "/test667/run.sh"]
