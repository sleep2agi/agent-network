FROM oven/bun:1.3.14

ARG TEST292_HARD_GATE_SOURCE_COMMIT=unknown
ENV TEST292_HARD_GATE_SOURCE_COMMIT=$TEST292_HARD_GATE_SOURCE_COMMIT

WORKDIR /app
COPY .github/workflows/e2e-docker.yml /app/.github/workflows/e2e-docker.yml
COPY tests/lib/run-piped-command.sh /app/tests/lib/run-piped-command.sh
COPY tests/lib/e2e-hard-gate.sh /app/tests/lib/e2e-hard-gate.sh
COPY tests/test292-e2e-hard-gate/run.sh /app/tests/test292-e2e-hard-gate/run.sh

RUN chmod +x \
  /app/tests/lib/run-piped-command.sh \
  /app/tests/lib/e2e-hard-gate.sh \
  /app/tests/test292-e2e-hard-gate/run.sh

CMD ["/app/tests/test292-e2e-hard-gate/run.sh"]
