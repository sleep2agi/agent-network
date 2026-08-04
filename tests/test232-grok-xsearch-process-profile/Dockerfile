FROM oven/bun:1.3.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates coreutils curl gcc libc6-dev python3 util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && chmod 4755 /usr/bin/bwrap

COPY tests/test232-grok-xsearch-process-profile /test232
COPY agent-node/src /workspace/agent-node/src
COPY agent-network/src /workspace/agent-network/src
RUN chmod 755 /test232/run.sh /test232/run-tui.sh /test232/pty-run.py

ENTRYPOINT ["bash", "/test232/run.sh"]
