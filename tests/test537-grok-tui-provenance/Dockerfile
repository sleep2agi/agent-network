# syntax=docker/dockerfile:1
FROM node:22.13.1-bookworm-slim

WORKDIR /gate

COPY tests/test537-grok-tui-provenance/run.sh /gate/run.sh
COPY --from=candidate docs/tests/report-test219.txt /candidate/docs/tests/report-test219.txt
COPY --from=candidate docs/tests/report-test224.txt /candidate/docs/tests/report-test224.txt
COPY --from=candidate docs/tests/report-test225.txt /candidate/docs/tests/report-test225.txt
COPY --from=candidate tests/test225-grok-preview-package-live/source-commit.txt /candidate/tests/test225-grok-preview-package-live/source-commit.txt

ENTRYPOINT ["/gate/run.sh"]
