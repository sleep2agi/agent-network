FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

WORKDIR /agent-node-src
COPY agent-node /agent-node-src
RUN cd /agent-node-src && bun install
COPY tests/test2028-vendor-replay-gate/run.sh /test2028/run.sh
RUN chmod +x /test2028/run.sh

ARG TEST2028_SOURCE_COMMIT=dev
ENV TEST2028_SOURCE_COMMIT=$TEST2028_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST2028_SOURCE_COMMIT

CMD ["bash", "/test2028/run.sh"]
