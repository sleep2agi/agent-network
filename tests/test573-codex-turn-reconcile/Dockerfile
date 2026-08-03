FROM oven/bun:1

WORKDIR /workspace
COPY run.sh /harness/run.sh
COPY run-mutation.sh /harness/run-mutation.sh
COPY mutate.mjs /harness/mutate.mjs
RUN chmod 0755 /harness/run.sh /harness/run-mutation.sh

ENTRYPOINT ["/harness/run.sh"]
