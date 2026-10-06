FROM oven/bun:1.3.1

WORKDIR /agent-node-src
COPY agent-node /agent-node-src
RUN cd /agent-node-src && bun install --frozen-lockfile
COPY tests/test656-capacity-retry/run.sh /test656/run.sh
RUN chmod +x /test656/run.sh

ARG TEST656_SOURCE_COMMIT=dev
ENV TEST656_SOURCE_COMMIT=$TEST656_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST656_SOURCE_COMMIT

CMD ["bash", "/test656/run.sh"]
