FROM oven/bun:1.3.1

# Only the gate source. A full agent-node install pulls SDKs this suite never runs.
WORKDIR /work
COPY agent-node/src/runtime/codex-app-server/start-resource-gate.ts /agent-node-src/src/runtime/codex-app-server/start-resource-gate.ts
COPY tests/test612-start-admission/probe.mjs /test612/probe.mjs
COPY tests/test612-start-admission/race.mjs /test612/race.mjs
COPY tests/test612-start-admission/recheck.mjs /test612/recheck.mjs
COPY tests/test612-start-admission/reentry.mjs /test612/reentry.mjs
COPY tests/test612-start-admission/run.sh /test612/run.sh
RUN chmod +x /test612/run.sh

ARG TEST612_SOURCE_COMMIT=dev
ENV TEST612_SOURCE_COMMIT=$TEST612_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST612_SOURCE_COMMIT

CMD ["bash", "/test612/run.sh"]
