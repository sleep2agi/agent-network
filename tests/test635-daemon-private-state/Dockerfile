FROM oven/bun:1.3.14

WORKDIR /work
COPY agent-node/src ./agent-node/src
COPY tests/test635-daemon-private-state/run.sh /run.sh

ARG TEST635_SOURCE_COMMIT=unknown
ENV TEST635_SOURCE_COMMIT=$TEST635_SOURCE_COMMIT

RUN useradd --create-home --uid 10001 runner \
 && useradd --create-home --uid 10002 foreign \
 && install -d -m 0755 -o foreign -g foreign /fixtures/foreign/.anet \
 && printf '%s\n' '{"token":"ntok_fixture"}' > /fixtures/foreign/.anet/config.json \
 && chown foreign:foreign /fixtures/foreign/.anet/config.json \
 && chmod 0600 /fixtures/foreign/.anet/config.json \
 && chmod 0755 /run.sh

USER runner
ENTRYPOINT ["/run.sh"]
