FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  coreutils \
  curl \
  git \
  jq \
  procps \
  sed \
  tar \
  unzip \
  xz-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /probe
COPY tests/test-grok-build-capability/run.sh /probe/run.sh
RUN chmod +x /probe/run.sh

CMD ["/probe/run.sh"]
