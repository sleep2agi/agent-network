FROM oven/bun:1.3.14

RUN apt-get update \
  && apt-get install -y --no-install-recommends procps strace \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work

COPY server/ server/
COPY contracts/side-thread/v1/ contracts/side-thread/v1/
COPY agent-node/src/ agent-node/src/
# The daemon credential tests import CLI error guidance and recursively inspect
# production token issuers. Keep the same cross-package inputs as test798.
COPY agent-network/package.json agent-network/package-lock.json agent-network/
COPY agent-network/src/ agent-network/src/
COPY agent-network/bin/ agent-network/bin/
# daemon-provider-snapshots.test.ts execs the pinned anet binary. The aggregate
# runner strips the environment, so the production trust root (/etc path.conf)
# has to name a real package bin. Without it the three CLI tests fail closed
# with anet_bin_unsafe_path.
RUN cd agent-network && bun install --ignore-scripts \
  && bun build bin/cli.ts --outdir dist/bin --target node \
    --external @inquirer/prompts \
    --external @sleep2agi/commhub-server \
    --external bun:sqlite --external node-pty \
    --external '../../server/*' \
  && cp bin/anet.cjs dist/bin/anet.cjs \
  && chmod 755 dist/bin/anet.cjs \
  && install -d -m 0755 /etc/anet-daemon \
  && printf 'ANET_BIN_ABS=%s\n' "$(realpath -e "$PWD/dist/bin/anet.cjs")" > /etc/anet-daemon/path.conf \
  && chmod 644 /etc/anet-daemon/path.conf
COPY tests/test601-hub-scheduled-tasks/ tests/test601-hub-scheduled-tasks/
RUN cd server && bun install

COPY tests/test638b-aggregate-trace/run.sh /work/run.sh
RUN chmod +x /work/run.sh

ARG TEST639_SOURCE_COMMIT
ENV TEST639_SOURCE_COMMIT=${TEST639_SOURCE_COMMIT}

CMD ["/work/run.sh"]
