FROM node:22-bookworm-slim

ARG SOURCE_COMMIT=dev
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash coreutils grep sed \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash tester

COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
COPY deploy/hub/hub-daemon.sh /app/deploy/hub/hub-daemon.sh
COPY tests/test2124-hub-launcher-env-scrub/run.sh /app/run.sh
RUN chmod 0755 /app/deploy/hub/hub-daemon.sh /app/run.sh

USER tester
WORKDIR /app
CMD ["bash", "/app/run.sh"]
