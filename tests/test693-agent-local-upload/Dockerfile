FROM oven/bun:1.2
WORKDIR /workspace
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
LABEL source_commit=${SOURCE_COMMIT}
# Copy full monorepo for in-image unit + integrate + dual e2e
COPY . /workspace
WORKDIR /workspace
RUN bun --version
# Default: unit+mutation+in-process; dual-container invoked via compose
CMD ["bash", "tests/test693-agent-local-upload/run.sh"]
