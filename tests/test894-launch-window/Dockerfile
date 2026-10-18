FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /source
COPY agent-node/src/ /source/agent-node/src/
COPY tests/test894-launch-window/ /fixture/
USER bun
CMD ["sh", "/fixture/run.sh"]
