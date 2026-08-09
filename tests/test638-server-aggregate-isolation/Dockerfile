FROM oven/bun:1.3.14

RUN apt-get update \
  && apt-get install -y --no-install-recommends strace \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work

COPY server/ server/
COPY agent-node/src/shared/ agent-node/src/shared/
COPY tests/test601-hub-scheduled-tasks/ tests/test601-hub-scheduled-tasks/
RUN cd server && bun install

COPY tests/test638-server-aggregate-isolation/run.sh /work/run.sh
RUN chmod +x /work/run.sh

ARG TEST638_SOURCE_COMMIT
ENV TEST638_SOURCE_COMMIT=${TEST638_SOURCE_COMMIT}

CMD ["/work/run.sh"]
