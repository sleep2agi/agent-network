FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git jq procps python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /probe

COPY run.sh /probe/run.sh
COPY acp-probe.mjs /probe/acp-probe.mjs
COPY acp-resume-probe.mjs /probe/acp-resume-probe.mjs

RUN chmod +x /probe/run.sh

ENTRYPOINT ["/probe/run.sh"]
