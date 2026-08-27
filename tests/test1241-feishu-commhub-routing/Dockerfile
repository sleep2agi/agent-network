FROM oven/bun:latest

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT

WORKDIR /src
COPY . .

RUN cd agent-network && bun install --ignore-scripts

CMD ["bash", "tests/test1241-feishu-commhub-routing/run.sh"]
