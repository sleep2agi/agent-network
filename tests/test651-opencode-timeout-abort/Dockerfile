FROM oven/bun:1.3.1

WORKDIR /agent-node-src
COPY agent-node /agent-node-src
RUN cd /agent-node-src && bun install --frozen-lockfile
COPY tests/test651-opencode-timeout-abort/run.sh /test651/run.sh
RUN chmod +x /test651/run.sh

ARG TEST651_SOURCE_COMMIT=dev
ENV TEST651_SOURCE_COMMIT=$TEST651_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST651_SOURCE_COMMIT

CMD ["bash", "/test651/run.sh"]
