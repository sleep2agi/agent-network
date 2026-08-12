FROM node:22-bookworm-slim

ARG SOURCE_COMMIT=dev
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash coreutils grep \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash tester

COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
COPY deploy/hub/hub-daemon.sh /app/deploy/hub/hub-daemon.sh
COPY deploy/hub/ecosystem.config.cjs /app/deploy/hub/ecosystem.config.cjs
COPY tests/test735-hub-daemon-rebuild/run.sh /app/run.sh
RUN chmod 0755 /app/deploy/hub/hub-daemon.sh /app/run.sh

USER tester
ENV HOME=/home/tester
WORKDIR /app
CMD ["bash", "/app/run.sh"]
