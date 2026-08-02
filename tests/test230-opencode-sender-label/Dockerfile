FROM oven/bun:1.3.1

WORKDIR /agent-node-src
COPY agent-node /agent-node-src
COPY tests/test230-opencode-sender-label/run.sh /test230/run.sh
RUN chmod +x /test230/run.sh

CMD ["bash", "/test230/run.sh"]
