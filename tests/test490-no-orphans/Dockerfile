FROM oven/bun:1.2

RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux procps git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

CMD ["bash", "tests/test490-no-orphans/run.sh"]
