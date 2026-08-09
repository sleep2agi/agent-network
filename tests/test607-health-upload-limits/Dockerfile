FROM oven/bun:1.3.14

WORKDIR /workspace
COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts

COPY server ./server
COPY tests/test607-health-upload-limits ./tests/test607-health-upload-limits

ARG SOURCE_COMMIT
ENV TEST607_SOURCE_COMMIT=$SOURCE_COMMIT
RUN chmod 0755 /workspace/tests/test607-health-upload-limits/run.sh
ENTRYPOINT ["/workspace/tests/test607-health-upload-limits/run.sh"]
