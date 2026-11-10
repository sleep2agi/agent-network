# Local, isolated doc-claim probe; the release artifact is mounted read-only.
# Rebuild the shared base from locked repository inputs when absent:
# sg docker -c 'docker build -f tests/test906-daemon-provider-management/Dockerfile.discovery -t anet-provider:test906-release-candidate .'
FROM anet-provider:test906-release-candidate
COPY tests/test906-cli165-doc-release/run.mjs /probe/run.mjs
CMD ["node", "/probe/run.mjs"]
