FROM oven/bun:1.3.14

WORKDIR /workspace/server
COPY server/package.json ./package.json
RUN bun install --ignore-scripts
COPY server ./
COPY tests/test630-file-download-header-auth/run.sh /test630/run.sh
RUN chmod 0755 /test630/run.sh

ARG SOURCE_COMMIT=unknown
ENV TEST630_SOURCE_COMMIT=${SOURCE_COMMIT}

ENTRYPOINT ["/test630/run.sh"]
