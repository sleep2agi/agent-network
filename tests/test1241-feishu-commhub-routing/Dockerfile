FROM oven/bun:latest

WORKDIR /src
COPY . .

RUN cd agent-network && bun install --ignore-scripts

CMD ["bash", "tests/test1241-feishu-commhub-routing/run.sh"]
