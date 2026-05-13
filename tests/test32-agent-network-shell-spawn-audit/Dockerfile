FROM oven/bun:1

WORKDIR /app

COPY agent-network/ agent-network/
COPY tests/test32-agent-network-shell-spawn-audit/run.sh /app/run.sh

RUN chmod +x /app/run.sh

CMD ["bash", "/app/run.sh"]
