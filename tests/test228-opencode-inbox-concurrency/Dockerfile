FROM oven/bun:1.3.1

WORKDIR /agent-node-src
COPY agent-node /agent-node-src
COPY tests/test228-opencode-inbox-concurrency/run.sh /test228/run.sh
RUN chmod +x /test228/run.sh

CMD ["bash", "/test228/run.sh"]
