FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
# python3-slim + bun copied in (the pattern #1324 uses): the instrument needs
# python3 and the suite must run on the SAME bun version the repo pins
# (`.github/workflows/qa.yml` → `bun-version: 1.3.14`). No credentials, no npm.
FROM python:3.11-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN bun --version && python3 --version
WORKDIR /suite
# The instrument is copied from the committed source — the witnesses below are
# witnesses for THIS file, not for a copy pasted into the fixture dir.
COPY scripts/check-test-margin.py /suite/check-test-margin.py
# read by the last check: qa.sh must clear the previous run's logs before reading them
COPY scripts/qa.sh /suite/qa.sh
COPY tests/test1627-test-margin/fixtures/ /suite/fixtures/
COPY tests/test1627-test-margin/run.sh /suite/run.sh
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["bash", "/suite/run.sh"]
