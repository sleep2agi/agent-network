FROM oven/bun:1.3.14

WORKDIR /repo
ARG TEST661_SOURCE_COMMIT=unknown
ENV TEST661_SOURCE_COMMIT=$TEST661_SOURCE_COMMIT

COPY agent-network/package.json /repo/agent-network/package.json
# node-pty is unrelated to this CLI/bootstrap suite. Avoid its native
# postinstall while retaining the package/type surface used by the build.
RUN cd /repo/agent-network && bun install --ignore-scripts

COPY agent-network /repo/agent-network
COPY tests/lib /repo/tests/lib
COPY tests/test661-explicit-bootstrap-db /repo/tests/test661-explicit-bootstrap-db
RUN chmod +x /repo/tests/test661-explicit-bootstrap-db/run.sh \
  /repo/tests/test661-explicit-bootstrap-db/fake-bin/bun

CMD ["bash", "/repo/tests/test661-explicit-bootstrap-db/run.sh"]
