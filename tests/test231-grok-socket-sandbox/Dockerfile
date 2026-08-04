FROM oven/bun:1.3.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap coreutils procps python3 util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && chmod 4755 /usr/bin/bwrap

WORKDIR /workspace
COPY agent-network/src/grok-copresence-profile.ts /workspace/agent-network/src/grok-copresence-profile.ts
COPY agent-network/src/grok-copresence-profile.test.ts /workspace/agent-network/src/grok-copresence-profile.test.ts
COPY tests/test231-grok-socket-sandbox /test231
ARG TEST231_LEGACY_XDG=0
RUN if [ "$TEST231_LEGACY_XDG" = 1 ]; then bun /test231/mutate-xdg-first.ts; fi

ENTRYPOINT ["bash", "/test231/run.sh"]
