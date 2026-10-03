FROM oven/bun:1.3.14

WORKDIR /workspace

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY tests/test516-anet-secret-masking ./tests/test516-anet-secret-masking

ARG SOURCE_COMMIT
ENV TEST516_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test516-anet-secret-masking/run.sh
ENTRYPOINT ["/workspace/tests/test516-anet-secret-masking/run.sh"]
