FROM oven/bun:1.3.14
WORKDIR /workspace

COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts
COPY server ./server
COPY tests/test647-rest-explicit-columns/run.sh /run.sh

ARG TEST647_SOURCE_COMMIT=unknown
ENV TEST647_SOURCE_COMMIT=$TEST647_SOURCE_COMMIT

RUN chmod 0755 /run.sh
ENTRYPOINT ["/run.sh"]
