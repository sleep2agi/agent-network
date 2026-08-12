FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /workspace

COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts
COPY server ./server
COPY tests/test686-rest-shape-golden ./tests/test686-rest-shape-golden

ARG TEST686_SOURCE_COMMIT=unknown
ENV TEST686_SOURCE_COMMIT=$TEST686_SOURCE_COMMIT

RUN chmod 0755 tests/test686-rest-shape-golden/run.sh
ENTRYPOINT ["/workspace/tests/test686-rest-shape-golden/run.sh"]
