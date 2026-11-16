FROM oven/bun:1.3.14
WORKDIR /workspace
COPY contracts ./contracts
COPY server/package.json server/package-lock.json ./server/
RUN cd server && bun install --frozen-lockfile --ignore-scripts
COPY server ./server
COPY tests/test4616-permissions ./tests/test4616-permissions
CMD ["bash", "tests/test4616-permissions/run.sh"]
