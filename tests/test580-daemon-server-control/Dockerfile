FROM oven/bun:1.3.9-debian
WORKDIR /app
COPY server /app/server
COPY agent-node /app/agent-node
COPY tests/test580-daemon-server-control/run.sh /app/run.sh
RUN cd /app/server && bun install --frozen-lockfile
RUN cd /app/agent-node && bun install --frozen-lockfile
RUN chmod +x /app/run.sh
CMD ["/app/run.sh"]
