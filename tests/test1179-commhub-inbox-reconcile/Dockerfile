FROM oven/bun:1.3.14
WORKDIR /workspace
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
RUN cd agent-node && bun install --frozen-lockfile
COPY agent-node ./agent-node
COPY tests/test1179-commhub-inbox-reconcile/run.sh ./run.sh
RUN chmod +x ./run.sh
CMD ["./run.sh"]
