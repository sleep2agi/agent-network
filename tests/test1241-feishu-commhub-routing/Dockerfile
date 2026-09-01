FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT

WORKDIR /src
COPY . .

RUN cd agent-network && bun install --ignore-scripts

CMD ["bash", "tests/test1241-feishu-commhub-routing/run.sh"]
