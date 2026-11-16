FROM oven/bun:1.3.14
WORKDIR /workspace
COPY agent-node ./agent-node
COPY agent-network ./agent-network
COPY contracts ./contracts
COPY server/src/contracts ./server/src/contracts
COPY tests/test-rfc044-windows-daemon ./tests/test-rfc044-windows-daemon
CMD ["bash", "tests/test-rfc044-windows-daemon/run.sh"]
