FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /work
COPY agent-node/src ./src
COPY agent-network/src ./cli-src
COPY tests/test626-daemon-adoption/run.sh ./run.sh
CMD ["bash", "/work/run.sh"]
