FROM python:3.12-slim

ARG TEST292_SOURCE_COMMIT=unknown
ENV TEST292_SOURCE_COMMIT=${TEST292_SOURCE_COMMIT}

WORKDIR /src
COPY tests/docker-e2e.sh tests/docker-e2e.sh
COPY tests/lib/ tests/lib/
COPY tests/test292-e2e-ok-assertions/run.sh tests/test292-e2e-ok-assertions/run.sh

RUN chmod +x tests/test292-e2e-ok-assertions/run.sh
ENTRYPOINT ["bash", "tests/test292-e2e-ok-assertions/run.sh"]
