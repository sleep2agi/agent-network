FROM oven/bun:1.3.14
WORKDIR /workspace
COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts
COPY server ./server
COPY tests/test599-skillhub ./tests/test599-skillhub
ARG SOURCE_COMMIT
ENV TEST599_SOURCE_COMMIT=$SOURCE_COMMIT
RUN chmod 0755 /workspace/tests/test599-skillhub/run.sh
ENTRYPOINT ["/workspace/tests/test599-skillhub/run.sh"]
