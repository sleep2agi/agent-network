FROM node:22-bookworm-slim

WORKDIR /workspace
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
COPY docs-site/package*.json docs-site/
RUN npm ci --prefix docs-site --ignore-scripts
COPY server/src/tools.ts server/src/tools.ts
COPY docs-site docs-site
COPY tests/test520-ack-inbox-docs/run.sh tests/test520-ack-inbox-docs/run.sh
RUN chmod +x tests/test520-ack-inbox-docs/run.sh

ARG TEST520_DOCS_SOURCE_COMMIT=unknown
ENV TEST520_DOCS_SOURCE_COMMIT=$TEST520_DOCS_SOURCE_COMMIT

CMD ["tests/test520-ack-inbox-docs/run.sh"]
