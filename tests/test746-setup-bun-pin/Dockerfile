FROM python:3.12-slim-bookworm

ARG TEST746_SOURCE_COMMIT=dev
ENV TEST746_SOURCE_COMMIT=$TEST746_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST746_SOURCE_COMMIT

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-yaml \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY .github/workflows ./.github/workflows
COPY tests/test746-setup-bun-pin/run.sh ./run.sh
RUN chmod 0755 ./run.sh

CMD ["bash", "./run.sh"]
