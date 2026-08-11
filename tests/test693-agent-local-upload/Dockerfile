FROM oven/bun:1.2
WORKDIR /workspace
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
LABEL source_commit=${SOURCE_COMMIT}
COPY . /workspace
WORKDIR /workspace
RUN bun --version
CMD ["bash", "tests/test693-agent-local-upload/run.sh"]
