FROM oven/bun:1.3.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl jq ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY . .
WORKDIR /repo/server
RUN bun install

WORKDIR /repo
ARG TEST198_SOURCE_COMMIT=dev
ENV TEST198_SOURCE_COMMIT=$TEST198_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST198_SOURCE_COMMIT

CMD ["bash", "tests/test198-from-alias/run.sh"]
