FROM node:22-bookworm-slim

ARG SOURCE_COMMIT=dev
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash coreutils jq \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash vansin \
    && mkdir -p /home/vansin/.nvm/versions/node/v20.20.0/bin \
    && ln -s /usr/local/bin/node /home/vansin/.nvm/versions/node/v20.20.0/bin/node

COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
COPY deploy/fleet/pm2-fleet-boot.sh /app/deploy/fleet/pm2-fleet-boot.sh
COPY deploy/fleet/pm2-fleet.service /app/deploy/fleet/pm2-fleet.service
COPY deploy/fleet/process-inventory.json /app/deploy/fleet/process-inventory.json
COPY tests/test736-pm2-fleet-rebuild/run.sh /app/run.sh
RUN chmod 0755 /app/deploy/fleet/pm2-fleet-boot.sh /app/run.sh \
    && chown -R vansin:vansin /home/vansin

USER vansin
ENV HOME=/home/vansin
WORKDIR /app
CMD ["bash", "/app/run.sh"]
