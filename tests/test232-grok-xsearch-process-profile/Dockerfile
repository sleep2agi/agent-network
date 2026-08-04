FROM oven/bun:1.3.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates coreutils curl util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && chmod 4755 /usr/bin/bwrap

COPY tests/test232-grok-xsearch-process-profile /test232
RUN chmod 755 /test232/run.sh

ENTRYPOINT ["bash", "/test232/run.sh"]
